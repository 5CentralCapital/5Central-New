import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksOAuthConnectionService, hashQuickBooksOAuthState, type QuickBooksOAuthState, type QuickBooksOAuthStateStore } from "./oauth-state";

const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "sandbox" as const, realmId: "123456" };

test("OAuth state is session/entity bound, one use, and returns metadata without tokens", async () => {
  const pending = new Map<string, QuickBooksOAuthState>();
  const stateStore: QuickBooksOAuthStateStore = {
    async create(value) { pending.set(value.stateHash, value); },
    async peek(hash) { return pending.get(hash) ?? null; },
    async consume(hash) {
      const value = pending.get(hash);
      if (!value) return null;
      pending.delete(hash);
      return value;
    },
  };
  let savedScope: unknown;
  const service = createQuickBooksOAuthConnectionService({
    oauth: {
      getAuthorizationUrl: state => `https://appcenter.intuit.com/connect/oauth2?state=${state}`,
      exchangeAuthorizationCode: async () => ({ accessToken: "secret-access", refreshToken: "secret-refresh", tokenType: "bearer", accessTokenExpiresAt: "2027-01-01T00:00:00.000Z" }),
    },
    stateStore,
    tokenManager: {
      saveTokens: async (value, token) => { savedScope = value; return { ...token, version: 1 }; },
    },
    verifyRealmBinding: async input => {
      assert.equal(input.actorId, "actor");
      assert.equal(input.legalEntityId, scope.legalEntityId);
    },
  });
  const begun = await service.begin({ ...scope, actorId: "actor", sessionBinding: "browser-session-123" });
  assert.equal((await service.peek(begun.state))?.legalEntityId, scope.legalEntityId);
  await assert.rejects(() => service.complete({ state: begun.state, actorId: "other", sessionBinding: "browser-session-123", code: "code", callbackRealmId: "123456" }), /actor/);
  // The failed actor check consumed the state, so a callback cannot replay it.
  await assert.rejects(() => service.complete({ state: begun.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code", callbackRealmId: "123456" }), /invalid, expired, or already used/);

  const second = await service.begin({ ...scope, actorId: "actor", sessionBinding: "browser-session-123" });
  const result = await service.complete({ state: second.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code", callbackRealmId: "123456" });
  assert.deepEqual(savedScope, scope);
  assert.equal(result.scope.realmId, "123456");
  assert.equal("accessToken" in result, false);
  assert.equal("refreshToken" in result.connection, false);
  assert.equal(hashQuickBooksOAuthState(second.state).length, 64);
});

test("first OAuth callback persists an encrypted handoff until the administrator confirms CompanyInfo", async () => {
  const pending = new Map<string, { actorId: string; sessionBindingHash: string | null; scope: typeof scope; proof: { providerCompanyId: string; providerCompanyName: string; providerLegalName: string | null; homeCurrency: string; evidenceVersion: string; companyInfoHash: string; existingBinding: false }; token: { accessToken: string; refreshToken: string; tokenType: "bearer"; accessTokenExpiresAt: string }; expiresAt: string }>();
  let createdState: QuickBooksOAuthState | null = null;
  const stateStore: QuickBooksOAuthStateStore = {
    async create(value) { createdState = value; pending.set(value.stateHash, { actorId: value.actorId, sessionBindingHash: value.sessionBindingHash, scope, proof: { providerCompanyId: "company-1", providerCompanyName: "Example QBO", providerLegalName: null, homeCurrency: "USD", evidenceVersion: "v1", companyInfoHash: "a".repeat(64), existingBinding: false }, token: { accessToken: "a", refreshToken: "r", tokenType: "bearer", accessTokenExpiresAt: "2027-01-01T00:00:00.000Z" }, expiresAt: value.expiresAt }); },
    async peek() { return null; },
    async consume() { return createdState; },
  };
  let savedScope: unknown;
  const pendingStore = {
    async create(input: any) { pending.set("pending-1", { ...input, pendingId: "pending-1" }); return { pendingId: "pending-1", expiresAt: input.expiresAt }; },
    async consume() { const value = pending.get("pending-1"); pending.delete("pending-1"); return value ? { pendingId: "pending-1", ...value } : null; },
  };
  const service = createQuickBooksOAuthConnectionService({
    oauth: { getAuthorizationUrl: state => `https://example.test/?state=${state}`, exchangeAuthorizationCode: async () => ({ accessToken: "a", refreshToken: "r", tokenType: "bearer", accessTokenExpiresAt: "2027-01-01T00:00:00.000Z" }) },
    stateStore,
    pendingBindingStore: pendingStore,
    confirmPendingBinding: async input => {
      const handoff = pending.get(input.pendingId);
      if (!handoff) throw new Error("missing pending handoff");
      assert.equal(input.sessionBindingHash, handoff.sessionBindingHash);
      savedScope = handoff.scope;
      return {
        status: "connected" as const,
        scope: handoff.scope,
        connection: { accessTokenExpiresAt: handoff.token.accessTokenExpiresAt, version: 1 },
      };
    },
    tokenManager: { saveNewConnection: async (value, token) => { savedScope = value; return { ...token, version: 1 }; }, saveTokens: async (value, token) => { savedScope = value; return { ...token, version: 1 }; } },
    verifyRealmBinding: async () => ({ providerCompanyId: "company-1", providerCompanyName: "Example QBO", providerLegalName: null, homeCurrency: "USD", evidenceVersion: "v1", companyInfoHash: "a".repeat(64), existingBinding: false }),
  });
  const begun = await service.begin({ ...scope, actorId: "actor", sessionBinding: "browser-session-123" });
  const callback = await service.complete({ state: begun.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code", callbackRealmId: scope.realmId });
  assert.equal(callback.status, "pending_confirmation");
  if (callback.status !== "pending_confirmation") throw new Error("expected pending confirmation");
  const confirmed = await service.confirm({ pendingId: callback.pendingId, actorId: "actor", sessionBinding: "browser-session-123", organizationId: scope.organizationId, legalEntityId: scope.legalEntityId });
  assert.equal(confirmed.status, "connected");
  assert.deepEqual(savedScope, scope);
});
