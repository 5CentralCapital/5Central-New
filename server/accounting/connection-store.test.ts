import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQuickBooksTokenRepository } from "./connection-store";
import { createQboTokenCipher } from "./token-crypto";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "123456" };
const token = {
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  tokenType: "bearer" as const,
  accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
  refreshTokenExpiresAt: "2027-02-01T00:00:00.000Z",
  intuitTid: "tid-1",
};

test("connection storage encrypts credentials and rejects stale refresh/revoked resurrection", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const repository = createQuickBooksTokenRepository(synthetic.executor, createQboTokenCipher(Buffer.alloc(32, 7)));
    const saved = await repository.save(scope, token);
    assert.equal(saved.accessToken, token.accessToken);
    assert.equal((await repository.load(scope))?.refreshToken, token.refreshToken);
    const raw = await synthetic.db.query<{ encrypted_access_token: string; access_token_iv: string; access_token_auth_tag: string }>("SELECT encrypted_access_token,access_token_iv,access_token_auth_tag FROM accounting_qbo_connections");
    assert.notEqual(raw.rows[0]?.encrypted_access_token, token.accessToken);
    assert.ok(raw.rows[0]?.access_token_iv);
    assert.ok(raw.rows[0]?.access_token_auth_tag);

    const rotated = { ...token, accessToken: "rotated-access", refreshToken: "rotated-refresh" };
    const rotatedSaved = await repository.save(scope, rotated, saved.version);
    assert.equal(rotatedSaved.accessToken, "rotated-access");
    await assert.rejects(() => repository.save(scope, token, saved.version), /changed during token rotation/);
    await repository.revoke(scope);
    assert.equal(await repository.load(scope), null);
    await assert.rejects(() => repository.save(scope, token), /changed during token rotation/);
    const reconnected = await repository.saveNewConnection(scope, token);
    assert.equal(reconnected.refreshToken, token.refreshToken);
  } finally {
    await synthetic.close();
  }
});
