import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createCompanyDemoApp } from "../company/demo";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};

test("Accounting HTTP requires environment and reads named mirrors through the restricted company executor", async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${scope.organizationId}/accounting/qbo`;
  try {
    await fixture.services.accounting.mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "bank-1",
      version: "0",
      providerUpdatedAt: "2026-09-21T12:00:00.000Z",
      providerBody: { Id: "bank-1", Name: "Operating account", AccountType: "Bank", Active: true },
      receivedAt: "2026-09-21T12:00:00.000Z",
    });

    const missingEnvironment = await fetch(`${base}/mirrors?legalEntityId=${scope.legalEntityId}&realmId=${scope.realmId}&kind=accounts`);
    assert.equal(missingEnvironment.status, 400);

    const mirrors = await fetch(`${base}/mirrors?legalEntityId=${scope.legalEntityId}&environment=sandbox&realmId=${scope.realmId}&kind=accounts`);
    assert.equal(mirrors.status, 200, await mirrors.clone().text());
    const payload = await mirrors.json() as { items: Array<{ displayName: string; providerObjectId: string; objectType: string }> };
    assert.deepEqual(payload.items.map(item => [item.displayName, item.providerObjectId, item.objectType]), [["Operating account", "bank-1", "Account"]]);

    const connections = await fetch(`${base}/connections?legalEntityId=${scope.legalEntityId}&environment=sandbox`);
    assert.equal(connections.status, 200, await connections.clone().text());
    assert.deepEqual((await connections.json()).items, []);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

