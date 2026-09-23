import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SYNTHETIC_COMPANY as fixture } from "../../../../server/company/testing/synthetic-database";
import { createLaneTestApp } from "../../../../server/review-cases/test-app";
import { rentOpsAuthClient } from "../rent-ops/auth";
import { ReviewCaseApiError, reviewCaseEnvelope, reviewCasesApi } from "./api";

const organizationId = fixture.organizationId;

function routeClientTo(origin: string, actor: string): () => void {
  const client = rentOpsAuthClient as unknown as { request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  const original = client.request;
  client.request = (input, init = {}) => fetch(`${origin}${String(input)}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-test-actor": actor } });
  return () => { client.request = original; };
}

test("the case envelope carries the case's own entity and property", () => {
  assert.deepEqual(reviewCaseEnvelope(organizationId, {}).scope, { organizationId });
  assert.deepEqual(reviewCaseEnvelope(organizationId, {}, 1, { legalEntityId: fixture.entityId, propertyId: fixture.propertyId }).scope, { organizationId, legalEntityId: fixture.entityId, propertyId: fixture.propertyId });
  assert.deepEqual(reviewCaseEnvelope(organizationId, {}, 1, { legalEntityId: null, propertyId: fixture.propertyId }).scope, { organizationId }, "a property without its entity is never sent");
});

test("a property-scoped administrator can open and act on a property case it can list", async () => {
  const app = await createLaneTestApp();
  let restore: (() => void) | undefined;
  try {
    const operationId = randomUUID();
    const detected = await fetch(`${app.base}/review-case-commands/review_case.detect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, idempotencyKey: `d:${operationId}`, scope: { organizationId }, payload: {} }) });
    assert.equal(detected.status, 200, await detected.clone().text());
    await app.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ($1,$2,'property-admin','admin',$3,$4)", [randomUUID(), organizationId, fixture.entityId, fixture.propertyId]);
    restore = routeClientTo(app.origin, "property-admin");
    const list = await reviewCasesApi.list(organizationId, { legalEntityId: fixture.entityId, propertyId: fixture.propertyId });
    const item = list.items.find(candidate => candidate.propertyId === fixture.propertyId);
    assert.ok(item, JSON.stringify(list.items.map(candidate => candidate.scopeKey)));
    await assert.rejects(reviewCasesApi.get(organizationId, item.id), (error: unknown) => error instanceof ReviewCaseApiError && error.status === 403);
    const detail = await reviewCasesApi.get(organizationId, item.id, undefined, item);
    assert.equal(detail.id, item.id);
    await assert.rejects(reviewCasesApi.command(organizationId, "review_case.note", reviewCaseEnvelope(organizationId, { caseId: item.id, note: "org-only" })), (error: unknown) => error instanceof ReviewCaseApiError && error.status === 403);
    const receipt = await reviewCasesApi.command(organizationId, "review_case.start_research", reviewCaseEnvelope(organizationId, { caseId: item.id }, detail.recordRevision, detail));
    assert.equal(receipt.state, "saved_in_rops");
    assert.equal((await reviewCasesApi.get(organizationId, item.id, undefined, item)).state, "researching");
  } finally { restore?.(); await app.close(); }
});
