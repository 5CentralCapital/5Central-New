import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { PostgresQuickBooksPendingBindingStore } from "./binding";
import { createQboTokenCipher } from "./token-crypto";
import { hashQuickBooksSessionBinding } from "./oauth-state";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};

const proof = {
  providerCompanyId: "company-1",
  providerCompanyName: "Example QBO",
  providerLegalName: "Example Property LLC",
  homeCurrency: "USD",
  evidenceVersion: "v1",
  companyInfoHash: "a".repeat(64),
  existingBinding: false as const,
};

const token = {
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  tokenType: "bearer" as const,
  accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
};

test("pending CompanyInfo handoffs allow repeated attempts and consume only after atomic confirmation work succeeds", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    const store = new PostgresQuickBooksPendingBindingStore(fixture.executor, createQboTokenCipher(Buffer.alloc(32, 7)));
    const sessionBindingHash = hashQuickBooksSessionBinding("browser-session-123");
    const input = { actorId: SYNTHETIC_COMPANY.actorId, sessionBindingHash, scope, proof, token, expiresAt: "2027-01-01T00:00:00.000Z" };
    const first = await store.create(input);
    const second = await store.create(input);
    assert.notEqual(first.pendingId, second.pendingId);

    await assert.rejects(
      () => store.confirm(first.pendingId, SYNTHETIC_COMPANY.actorId, sessionBindingHash, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, async () => {
        throw new Error("simulated token write failure");
      }),
      /simulated token write failure/,
    );
    const retryPreview = await store.preview(first.pendingId, SYNTHETIC_COMPANY.actorId, sessionBindingHash, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId });
    assert.equal(retryPreview?.proof.providerCompanyName, "Example QBO");

    const confirmed = await store.confirm(first.pendingId, SYNTHETIC_COMPANY.actorId, sessionBindingHash, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, async () => undefined);
    assert.equal(confirmed?.pendingId, first.pendingId);
    assert.equal(await store.preview(first.pendingId, SYNTHETIC_COMPANY.actorId, sessionBindingHash, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }), null);
    assert.equal((await store.consume(first.pendingId, SYNTHETIC_COMPANY.actorId, sessionBindingHash, { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId })), null);
  } finally {
    await fixture.close();
  }
});
