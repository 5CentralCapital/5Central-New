import assert from "node:assert/strict";
import test from "node:test";
import { createAccountingServices } from "./index";
import { createQboTokenCipher } from "./token-crypto";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

const firstScope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};

test("configured factory verifies CompanyInfo.Id, fences each legal entity by environment, and safely replays a committed confirmation", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const runtime = await createSyntheticRuntimeExecutor(fixture.db);
  const secondEntityId = "20000000-0000-4000-8000-000000000002";
  try {
    await fixture.db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Second Property LLC','llc','USD')", [secondEntityId, SYNTHETIC_COMPANY.organizationId]);
    await fixture.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id) VALUES ('40000000-0000-4000-8000-000000000002',$1,$2,'admin',$3)", [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.actorId, secondEntityId]);
    let firstCompanyName = "First QBO";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ access_token: "access-synthetic", refresh_token: "refresh-synthetic", expires_in: 3_600, x_refresh_token_expires_in: 86_400 }), {
          status: 200,
          headers: { intuit_tid: "tid-synthetic", "content-type": "application/json" },
        });
      }
      const realm = url.includes("/456/") ? "456" : "123456";
      return new Response(JSON.stringify({ CompanyInfo: { Id: realm === "456" ? "company-2" : "company-1", CompanyName: realm === "456" ? "Second QBO" : firstCompanyName, LegalName: realm === "456" ? "Second Property LLC" : "Example Property LLC", HomeCurrency: { value: "USD" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const services = createAccountingServices(runtime, {
      qbo: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app.example.test/api/callback",
        environment: "sandbox",
        tokenCipher: createQboTokenCipher(Buffer.alloc(32, 9)),
        transport: { fetchImpl },
      },
    });
    assert.equal(services.qbo.status, "configured");
    if (services.qbo.status !== "configured") throw new Error("expected configured QBO services");

    const begin = await services.qbo.oauthConnection.begin({ ...firstScope, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123" });
    const pending = await services.qbo.oauthConnection.complete({ state: begin.state, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", code: "code-1", callbackRealmId: firstScope.realmId });
    assert.equal(pending.status, "pending_confirmation");
    if (pending.status !== "pending_confirmation") throw new Error("expected pending CompanyInfo confirmation");
    const connected = await services.qbo.oauthConnection.confirm({ pendingId: pending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId });
    assert.equal(connected.status, "connected");
    const replay = await services.qbo.oauthConnection.confirm({ pendingId: pending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId });
    assert.equal(replay.status, "connected");
    assert.equal(replay.scope.realmId, firstScope.realmId);

    // A reconnect may change display metadata while retaining the stable
    // CompanyInfo.Id. It creates a new proof/audit row and its second submit
    // is a read-only replay of the committed connection.
    firstCompanyName = "First QBO Renamed";
    const reconnectBegin = await services.qbo.oauthConnection.begin({ ...firstScope, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123" });
    const reconnectPending = await services.qbo.oauthConnection.complete({ state: reconnectBegin.state, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", code: "code-reconnect", callbackRealmId: firstScope.realmId });
    assert.equal(reconnectPending.status, "pending_confirmation");
    if (reconnectPending.status !== "pending_confirmation") throw new Error("expected reconnect confirmation");
    const reconnectConnected = await services.qbo.oauthConnection.confirm({ pendingId: reconnectPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId });
    assert.equal(reconnectConnected.status, "connected");
    const reconnectReplay = await services.qbo.oauthConnection.confirm({ pendingId: reconnectPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId });
    assert.equal(reconnectReplay.status, "connected");

    // A committed confirmation cannot be replayed after its connection is
    // revoked; the audit row alone is not sufficient evidence of connectivity.
    const revokedConnectionBegin = await services.qbo.oauthConnection.begin({ ...firstScope, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123" });
    const revokedConnectionPending = await services.qbo.oauthConnection.complete({ state: revokedConnectionBegin.state, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", code: "code-revoked-connection", callbackRealmId: firstScope.realmId });
    assert.equal(revokedConnectionPending.status, "pending_confirmation");
    if (revokedConnectionPending.status !== "pending_confirmation") throw new Error("expected revoked-connection confirmation");
    await services.qbo.oauthConnection.confirm({ pendingId: revokedConnectionPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId });
    await services.qbo.tokenManager.disconnect(firstScope);
    await assert.rejects(
      () => services.qbo.oauthConnection.confirm({ pendingId: revokedConnectionPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId }),
      /could not be completed/,
    );

    const secondBegin = await services.qbo.oauthConnection.begin({ organizationId: firstScope.organizationId, legalEntityId: secondEntityId, environment: "sandbox", expectedRealmId: "456", actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123" });
    const secondPending = await services.qbo.oauthConnection.complete({ state: secondBegin.state, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", code: "code-2", callbackRealmId: "456" });
    assert.equal(secondPending.status, "pending_confirmation");
    if (secondPending.status !== "pending_confirmation") throw new Error("expected second legal-entity confirmation");
    const secondConnected = await services.qbo.oauthConnection.confirm({ pendingId: secondPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: secondEntityId });
    assert.equal(secondConnected.status, "connected");

    // The command rechecks grants in its commit transaction. A pending handoff
    // created before revocation cannot be confirmed, and even an already
    // committed handoff cannot be replayed by the revoked actor.
    const revokedGrantBegin = await services.qbo.oauthConnection.begin({ organizationId: firstScope.organizationId, legalEntityId: secondEntityId, environment: "sandbox", expectedRealmId: "456", actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123" });
    const revokedGrantPending = await services.qbo.oauthConnection.complete({ state: revokedGrantBegin.state, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", code: "code-revoked-grant", callbackRealmId: "456" });
    assert.equal(revokedGrantPending.status, "pending_confirmation");
    if (revokedGrantPending.status !== "pending_confirmation") throw new Error("expected revoked-grant confirmation");
    await fixture.db.query("UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2 AND revoked_at IS NULL", [firstScope.organizationId, SYNTHETIC_COMPANY.actorId]);
    await assert.rejects(
      () => services.qbo.oauthConnection.confirm({ pendingId: revokedGrantPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: secondEntityId }),
      /no active company grant/,
    );
    await assert.rejects(
      () => services.qbo.oauthConnection.confirm({ pendingId: reconnectPending.pendingId, actorId: SYNTHETIC_COMPANY.actorId, sessionBinding: "browser-session-123", organizationId: firstScope.organizationId, legalEntityId: firstScope.legalEntityId }),
      /no active company grant/,
    );
  } finally {
    await fixture.close();
  }
});
