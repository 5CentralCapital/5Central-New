import assert from "node:assert/strict";
import test from "node:test";
import { createTimeOAuthConnectionService, hashTimeOAuthState, type TimeOAuthState, type TimeOAuthStateStore } from "./oauth-state";

const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "production" as const, providerCompanyId: "company-1" };

test("Time OAuth state is actor and browser-session bound, single-use, and returns no secrets", async () => {
  const pending = new Map<string, TimeOAuthState>();
  const stateStore: TimeOAuthStateStore = {
    async create(state) { pending.set(state.stateHash, state); },
    async peek(hash) { return pending.get(hash) ?? null; },
    async consume(hash) { const value = pending.get(hash); if (!value) return null; pending.delete(hash); return value; },
  };
  let savedScope: unknown;
  const service = createTimeOAuthConnectionService({
    oauth: {
      authorizationUrl: ({ state }) => `https://rest.tsheets.com/api/v1/authorize?state=${state}`,
      exchangeCode: async () => ({ accessToken: "access-secret", refreshToken: "refresh-secret", tokenType: "bearer" as const, accessTokenExpiresAt: "2026-09-21T13:00:00.000Z", providerCompanyId: "company-1" }),
    },
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://rops.example.test/api/company/time/callback",
    stateStore,
    tokenRepository: { async saveNewConnection(input, token) { savedScope = input; return { ...token, version: 1, updatedAt: "2026-09-21T12:00:00.000Z" }; } },
  });
  const begun = await service.begin({ actorId: "actor", sessionBinding: "browser-session-123", scope });
  assert.equal((await service.peek(begun.state))?.scope.providerCompanyId, "company-1");
  await assert.rejects(() => service.complete({ state: begun.state, actorId: "other", sessionBinding: "browser-session-123", code: "code" }), /actor/);
  await assert.rejects(() => service.complete({ state: begun.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code" }), /invalid, expired, or already used/);
  const second = await service.begin({ actorId: "actor", sessionBinding: "browser-session-123", scope });
  await assert.rejects(() => service.complete({ state: second.state, actorId: "actor", sessionBinding: "other-session", code: "code" }), /session/);
  await assert.rejects(() => service.complete({ state: second.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code" }), /invalid, expired, or already used/);
  const third = await service.begin({ actorId: "actor", sessionBinding: "browser-session-123", scope });
  const result = await service.complete({ state: third.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code" });
  assert.deepEqual(savedScope, scope);
  assert.equal(result.scope.providerCompanyId, "company-1");
  assert.equal("accessToken" in result, false);
  assert.equal("refreshToken" in result.connection, false);
  assert.equal(hashTimeOAuthState(third.state).length, 64);
});

test("Time OAuth completion rejects a provider company identity mismatch", async () => {
  const pending = new Map<string, TimeOAuthState>();
  const stateStore: TimeOAuthStateStore = { async create(state) { pending.set(state.stateHash, state); }, async peek(hash) { return pending.get(hash) ?? null; }, async consume(hash) { const value = pending.get(hash); pending.delete(hash); return value ?? null; } };
  const service = createTimeOAuthConnectionService({
    oauth: { authorizationUrl: ({ state }) => state, exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", tokenType: "bearer" as const, accessTokenExpiresAt: "2026-09-21T13:00:00.000Z", providerCompanyId: "different-company" }) },
    clientId: "client", clientSecret: "secret", redirectUri: "https://rops.example.test/time/callback", stateStore,
    tokenRepository: { async saveNewConnection() { throw new Error("should not save"); } },
  });
  const begun = await service.begin({ actorId: "actor", sessionBinding: "browser-session-123", scope });
  await assert.rejects(() => service.complete({ state: begun.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code" }), /identity/);
});

test("Time OAuth can establish a first connection without a provider company ID", async () => {
  const pending = new Map<string, TimeOAuthState>();
  const stateStore: TimeOAuthStateStore = { async create(state) { pending.set(state.stateHash, state); }, async peek(hash) { return pending.get(hash) ?? null; }, async consume(hash) { const value = pending.get(hash); pending.delete(hash); return value ?? null; } };
  let savedScope: unknown;
  const service = createTimeOAuthConnectionService({
    oauth: {
      authorizationUrl: ({ state }) => `https://rest.tsheets.com/api/v1/authorize?state=${state}`,
      exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", tokenType: "bearer" as const, accessTokenExpiresAt: "2026-09-21T13:00:00.000Z", providerCompanyId: "first-company" }),
    },
    clientId: "client", clientSecret: "secret", redirectUri: "https://rops.example.test/time/callback", stateStore,
    tokenRepository: { async saveNewConnection(input, token) { savedScope = input; return { ...token, version: 1, updatedAt: "2026-09-21T12:00:00.000Z" }; } },
  });
  const begun = await service.begin({ actorId: "actor", sessionBinding: "browser-session-123", scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment } });
  assert.equal((await service.peek(begun.state))?.scope.providerCompanyId, null);
  const result = await service.complete({ state: begun.state, actorId: "actor", sessionBinding: "browser-session-123", code: "code" });
  assert.equal(result.scope.providerCompanyId, "first-company");
  assert.deepEqual(savedScope, { ...scope, providerCompanyId: "first-company" });
});
