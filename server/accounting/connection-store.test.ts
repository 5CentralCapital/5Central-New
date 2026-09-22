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
  refreshTokenHardExpiresAt: "2030-02-01T00:00:00.000Z",
  intuitTid: "tid-1",
};

test("connection storage encrypts credentials and rejects stale refresh/revoked resurrection", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const repository = createQuickBooksTokenRepository(synthetic.executor, createQboTokenCipher(Buffer.alloc(32, 7)));
    const saved = await repository.save(scope, token);
    assert.equal(saved.accessToken, token.accessToken);
    assert.equal((await repository.load(scope))?.refreshToken, token.refreshToken);
    assert.equal((await repository.load(scope))?.refreshTokenHardExpiresAt, token.refreshTokenHardExpiresAt);
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

test("needs-reconnect transition clears credentials, disables capabilities and writes a safe append-only event", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const repository = createQuickBooksTokenRepository(synthetic.executor, createQboTokenCipher(Buffer.alloc(32, 7)));
    await repository.save(scope, token);
    await synthetic.db.query(
      `INSERT INTO accounting_qbo_capabilities
        (organization_id,legal_entity_id,environment,realm_id,capability,enabled,evidence,evidence_version,verified_at)
       VALUES ($1,$2,$3,$4,'accounting.read',true,'live_provider_readback','verified',now())`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId],
    );
    await repository.markNeedsReconnect(scope, { reason: "invalid_grant", intuitTid: "tid-reconnect" });
    assert.equal(await repository.load(scope), null);
    assert.equal(await repository.readMetadata(scope), null);
    const listed = await repository.listMetadata({ organizationId: scope.organizationId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "needs_reconnect");
    const rows = await synthetic.db.query<{ event_type: string; reason_code: string; provider_trace_id: string; status: string; encrypted_refresh_token: unknown }>(
      `SELECT e.event_type,e.reason_code,e.provider_trace_id,c.status,c.encrypted_refresh_token
         FROM accounting_qbo_connection_events e JOIN accounting_qbo_connections c
           USING (organization_id,legal_entity_id,environment,realm_id)`,
    );
    assert.deepEqual(rows.rows, [{ event_type: "needs_reconnect", reason_code: "invalid_grant", provider_trace_id: "tid-reconnect", status: "needs_reconnect", encrypted_refresh_token: null }]);
    const capability = await synthetic.db.query<{ enabled: boolean; evidence: string }>("SELECT enabled,evidence FROM accounting_qbo_capabilities WHERE capability='accounting.read'");
    assert.deepEqual(capability.rows, [{ enabled: false, evidence: "unverified" }]);
    await assert.rejects(() => synthetic.db.query("UPDATE accounting_qbo_connection_events SET reason_code='refresh_token_expired'"), /accounting_qbo_connection_events_immutable/);
    const serialized = JSON.stringify({ events: rows.rows, capabilities: capability.rows });
    assert.doesNotMatch(serialized, /access-secret|refresh-secret/);
  } finally {
    await synthetic.close();
  }
});
