import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SYNTHETIC_COMPANY as fixture } from "../../../../server/company/testing/synthetic-database";
import { createLaneTestApp } from "../../../../server/review-cases/test-app";
import { rentOpsAuthClient } from "../rent-ops/auth";
import { CompanyDocumentsApiError, companyDocumentsApi, documentScope } from "./api";

const organizationId = fixture.organizationId;

/** Route the browser client to the synthetic server as a given actor. */
function routeClientTo(origin: string, actor: string): () => void {
  const client = rentOpsAuthClient as unknown as { request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  const original = client.request;
  client.request = (input, init = {}) => fetch(`${origin}${String(input)}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-test-actor": actor } });
  return () => { client.request = original; };
}

test("a property-scoped administrator can open, download, edit and archive a property document it can list", async () => {
  const app = await createLaneTestApp();
  let restore: (() => void) | undefined;
  try {
    // Upload a property document as the organization administrator.
    const input = { context: { organizationId, legalEntityId: fixture.entityId, propertyId: fixture.propertyId }, kind: "insurance", title: "Certificate", tags: [], links: [] };
    const bytes = Buffer.from("synthetic certificate");
    const prepared = await (await fetch(`${app.base}/documents/uploads`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-declared-content-type": "text/plain", "x-file-name": "certificate.txt", "x-document-metadata": Buffer.from(JSON.stringify(input)).toString("base64url") }, body: bytes })).json();
    const operationId = randomUUID();
    const created = await fetch(`${app.base}/document-commands/company_document.create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, idempotencyKey: `d:${operationId}`, scope: { organizationId, legalEntityId: fixture.entityId, propertyId: fixture.propertyId }, payload: { action: "create", stageId: prepared.stageId, input } }) });
    assert.equal(created.status, 200, await created.clone().text());

    await app.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ($1,$2,'property-admin','admin',$3,$4)", [randomUUID(), organizationId, fixture.entityId, fixture.propertyId]);
    restore = routeClientTo(app.origin, "property-admin");
    const page = await companyDocumentsApi.list(organizationId, { legalEntityId: fixture.entityId, propertyId: fixture.propertyId });
    assert.equal(page.items.length, 1);
    const listed = page.items[0]!;
    assert.deepEqual(documentScope(listed), { legalEntityId: fixture.entityId, propertyId: fixture.propertyId });

    // Organization-only addressing is outside a property grant; the document's own scope is inside it.
    await assert.rejects(companyDocumentsApi.get(organizationId, String(listed.id)), (error: unknown) => error instanceof CompanyDocumentsApiError && error.status === 403);
    const opened = await companyDocumentsApi.get(organizationId, String(listed.id), undefined, documentScope(listed));
    assert.equal(opened.id, listed.id);
    const blob = await companyDocumentsApi.download(organizationId, String(listed.id), undefined, documentScope(listed));
    assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), "synthetic certificate");
    const edited = await companyDocumentsApi.updateMetadata(organizationId, { documentId: String(listed.id), scope: documentScope(listed), expectedRevision: listed.recordRevision, title: "Certificate 2026" });
    assert.equal(edited.title, "Certificate 2026");
    await companyDocumentsApi.archive(organizationId, edited);
    assert.deepEqual((await companyDocumentsApi.list(organizationId, { legalEntityId: fixture.entityId, propertyId: fixture.propertyId })).items, []);
  } finally { restore?.(); await app.close(); }
});

test("browser upload preserves a Unicode filename through the raw file header", async () => {
  const app = await createLaneTestApp();
  let restore: (() => void) | undefined;
  try {
    restore = routeClientTo(app.origin, fixture.actorId);
    const fileName = "résumé 日本語.pdf";
    const document = await companyDocumentsApi.upload(organizationId, {
      context: { organizationId, legalEntityId: fixture.entityId, propertyId: fixture.propertyId },
      kind: "contract", title: "Unicode source", tags: [], links: [],
      file: new File([Buffer.from("%PDF-1.7\nsynthetic unicode source\n%%EOF")], fileName, { type: "application/pdf" }),
    });
    assert.equal(document.source.fileName, fileName);
    const opened = await companyDocumentsApi.get(organizationId, String(document.id), undefined, { legalEntityId: fixture.entityId, propertyId: fixture.propertyId });
    assert.equal(opened.source.fileName, fileName);
  } finally { restore?.(); await app.close(); }
});
