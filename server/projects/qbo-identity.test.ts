import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createCompanyDemoApp } from "../company/demo";
import { SYNTHETIC_COMPANY as company } from "../company/testing/synthetic-database";

const scope = { organizationId: company.organizationId, legalEntityId: company.entityId, propertyId: company.propertyId };
const envelope = (payload: unknown, revision?: number) => ({ operationId: randomUUID(), idempotencyKey: randomUUID(), scope, ...(revision === undefined ? {} : { expectedRevision: revision }), payload });

test("QBO project identity linking preserves native Project and Customer IDs with verified realm scope", async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${company.organizationId}`;
  const post = (kind: string, body: unknown) => fetch(`${base}/project-commands/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rent-ops-csrf": "rent-ops-demo-csrf-token-local-only-20260817" },
    body: JSON.stringify(body),
  });
  try {
    const created = await post("project.create", envelope({ name: "Synthetic QBO identity project", propertyId: company.propertyId, projectType: "flip", status: "active", startOn: "2024-01-01" }));
    assert.equal(created.status, 200, await created.clone().text());
    const createdReceipt = await created.json();
    const projectId = createdReceipt.affectedRecordIds[0];
    await fixture.database.db.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id, legal_entity_id, environment, realm_id, provider_company_id,
         provider_company_name, provider_legal_name, home_currency, evidence_version,
         company_info_hash, confirmed_by)
       VALUES ($1,$2,'production','1234567890','synthetic-qbo-company',
               'Synthetic QBO Company','Synthetic QBO Company','USD','test-v1',$3,'demo-admin')`,
      [company.organizationId, company.entityId, "a".repeat(64)],
    );
    const link = envelope({
      projectId,
      identities: [{ recordKind: "Project", externalId: "project-test-42" }, { recordKind: "Customer", externalId: "customer-test-42" }],
      environment: "production", realmId: "1234567890",
    }, 1);
    const linked = await post("project.qbo_identity.link", link);
    assert.equal(linked.status, 200, await linked.clone().text());
    const linkedReceipt = await linked.json();
    assert.equal(linkedReceipt.affectedRecordIds[0], projectId);
    const detailResponse = await fetch(`${base}/projects/${projectId}`);
    assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
    const detail = await detailResponse.json();
    assert.deepEqual(detail.qboProjectIdentities.map((identity: { recordKind: string; externalId: string }) => [identity.recordKind, identity.externalId]), [["Customer", "customer-test-42"], ["Project", "project-test-42"]]);
    const stored = await fixture.database.db.query<{ record_kind: string; external_id: string; local_id: string }>(
      `SELECT record_kind, external_id, local_id
         FROM company_external_identities
        WHERE organization_id=$1 AND provider='qbo' AND source_scope='qbo:production:1234567890' AND local_kind='project' AND local_id=$2
        ORDER BY record_kind`,
      [company.organizationId, projectId],
    );
    assert.deepEqual(stored.rows, [{ record_kind: "Customer", external_id: "customer-test-42", local_id: projectId }, { record_kind: "Project", external_id: "project-test-42", local_id: projectId }]);
    assert.deepEqual(await (await post("project.qbo_identity.link", link)).json(), linkedReceipt);

    const secondCreated = await post("project.create", envelope({ name: "Synthetic second QBO project", propertyId: company.propertyId, projectType: "flip", status: "planning", startOn: "2024-01-01" }));
    assert.equal(secondCreated.status, 200, await secondCreated.clone().text());
    const secondId = (await secondCreated.json()).affectedRecordIds[0];
    const collision = await post("project.qbo_identity.link", envelope({ projectId: secondId, identities: [{ recordKind: "Project", externalId: "project-test-42" }], environment: "production", realmId: "1234567890" }, 1));
    assert.equal(collision.status, 409);
    const unverifiedRealm = await post("project.qbo_identity.link", envelope({ projectId: secondId, identities: [{ recordKind: "Project", externalId: "999" }], environment: "sandbox", realmId: "987654321" }, 1));
    assert.equal(unverifiedRealm.status, 400);
    const wrongPropertyScope = await post("project.qbo_identity.link", {
      ...envelope({ projectId, identities: [{ recordKind: "Project", externalId: "project-test-43" }], environment: "production", realmId: "1234567890" }, 1),
      scope: { ...scope, propertyId: "synthetic-other-property" },
    });
    assert.equal(wrongPropertyScope.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
