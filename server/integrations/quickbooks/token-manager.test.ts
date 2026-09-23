import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksTokenManager } from "./token-manager";
import type { QuickBooksOAuthTokenSet, QuickBooksStoredToken, QuickBooksTokenRepository } from "../../../shared/accounting/quickbooks";
import { QuickBooksIntegrationError } from "./errors";

const scope = {
  organizationId: "org",
  legalEntityId: "entity",
  realmId: "123456",
  environment: "sandbox" as const,
};

const current = new Date("2026-09-21T12:00:00.000Z");
const rotated: QuickBooksOAuthTokenSet = {
  accessToken: "new-access",
  refreshToken: "new-refresh",
  tokenType: "bearer",
  accessTokenExpiresAt: "2026-09-21T13:00:00.000Z",
  refreshTokenExpiresAt: "2026-12-21T12:00:00.000Z",
};

test("expired access tokens refresh once and persist the latest refresh-token rotation", async () => {
  let stored: QuickBooksStoredToken = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenType: "bearer",
    accessTokenExpiresAt: "2026-09-21T11:00:00.000Z",
    refreshTokenExpiresAt: "2026-12-21T12:00:00.000Z",
    version: 3,
  };
  let refreshCalls = 0;
  let expectedVersion: number | undefined;
  const repository: QuickBooksTokenRepository = {
    async load() { return stored; },
    async save(_scope, token, expected) { expectedVersion = expected; stored = { ...token, version: 4 }; return stored; },
    async revoke() { stored = undefined as never; },
    async markNeedsReconnect() { stored = undefined as never; },
  };
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: {
      async refreshToken(refreshToken) { refreshCalls += 1; assert.equal(refreshToken, "old-refresh"); return rotated; },
      async revokeToken() { return {}; },
    },
    now: () => current,
  });
  assert.equal(await manager.getAccessToken(scope), "new-access");
  assert.equal(refreshCalls, 1);
  assert.equal(expectedVersion, 3);
  assert.equal(stored.refreshToken, "new-refresh");
  assert.equal(await manager.getAccessToken(scope), "new-access");
  assert.equal(refreshCalls, 1);
});

test("disconnect revokes before clearing the local token", async () => {
  const calls: string[] = [];
  const repository: QuickBooksTokenRepository = {
    async load() { return { accessToken: "access", refreshToken: "refresh", tokenType: "bearer", accessTokenExpiresAt: "2026-09-21T13:00:00.000Z", version: 1 }; },
    async save() { throw new Error("unused"); },
    async revoke() { calls.push("local-revoke"); },
    async markNeedsReconnect() { throw new Error("unused"); },
  };
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: { async refreshToken() { throw new Error("unused"); }, async revokeToken(token) { calls.push(`provider-revoke:${token}`); return {}; } },
  });
  await manager.disconnect(scope);
  assert.deepEqual(calls, ["provider-revoke:refresh", "local-revoke"]);
});

test("invalid_grant records needs-reconnect once and never repeats refresh or leaks provider text", async () => {
  const stored: QuickBooksStoredToken = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenType: "bearer",
    accessTokenExpiresAt: "2026-09-21T11:00:00.000Z",
    refreshTokenExpiresAt: "2026-12-21T12:00:00.000Z",
    version: 8,
  };
  let refreshCalls = 0;
  const transitions: { reason: string; intuitTid?: string }[] = [];
  const repository: QuickBooksTokenRepository = {
    async load() { return stored; },
    async save() { throw new Error("unused"); },
    async revoke() { throw new Error("unused"); },
    async markNeedsReconnect(_scope, details) { transitions.push(details); },
  };
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: {
      async refreshToken() {
        refreshCalls += 1;
        throw new QuickBooksIntegrationError("quickbooks_oauth", "QuickBooks token refresh failed", {
          status: 400,
          intuitTid: "tid-invalid-grant",
          details: { error: "invalid_grant", error_description: "sensitive-provider-message" },
        });
      },
      async revokeToken() { return {}; },
    },
    now: () => current,
  });
  await assert.rejects(() => manager.getAccessToken(scope), (error: unknown) => {
    assert.ok(error instanceof QuickBooksIntegrationError);
    assert.equal(error.code, "quickbooks_unauthorized");
    assert.equal(error.details.reason, "needs_reconnect");
    assert.doesNotMatch(error.message, /sensitive-provider-message|old-refresh/);
    return true;
  });
  await assert.rejects(() => manager.getAccessToken(scope), /needs to be reconnected/);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(transitions, [{ reason: "invalid_grant", intuitTid: "tid-invalid-grant" }]);
});

test("hard refresh-token expiry disables refresh and requests reconnect", async () => {
  const stored: QuickBooksStoredToken = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenType: "bearer",
    accessTokenExpiresAt: "2026-09-21T11:00:00.000Z",
    refreshTokenHardExpiresAt: "2026-09-21T11:59:59.000Z",
    version: 9,
  };
  let refreshCalls = 0;
  let reason = "";
  const repository: QuickBooksTokenRepository = {
    async load() { return stored; },
    async save() { throw new Error("unused"); },
    async revoke() { throw new Error("unused"); },
    async markNeedsReconnect(_scope, details) { reason = details.reason; },
  };
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: { async refreshToken() { refreshCalls += 1; throw new Error("must not refresh"); }, async revokeToken() { return {}; } },
    now: () => current,
  });
  await assert.rejects(() => manager.getAccessToken(scope), /needs to be reconnected/);
  assert.equal(reason, "refresh_token_hard_expired");
  assert.equal(refreshCalls, 0);
});

test("invalid_grant for a refresh token another worker already rotated does not disable the connection", async () => {
  const stale: QuickBooksStoredToken = { accessToken: "old-access", refreshToken: "old-refresh", tokenType: "bearer", accessTokenExpiresAt: "2026-09-21T11:00:00.000Z", version: 5 };
  const winner: QuickBooksStoredToken = { ...rotated, version: 6 };
  let loads = 0;
  let marked = 0;
  const repository: QuickBooksTokenRepository = {
    async load() { loads += 1; return loads === 1 ? stale : winner; },
    async save() { throw new Error("unused"); },
    async revoke() { throw new Error("unused"); },
    async markNeedsReconnect() { marked += 1; },
  };
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: {
      async refreshToken() { throw new QuickBooksIntegrationError("quickbooks_oauth", "QuickBooks OAuth token refresh failed", { status: 400, details: { error: "invalid_grant" } }); },
      async revokeToken() { return {}; },
    },
    now: () => current,
  });
  assert.equal(await manager.getAccessToken(scope), "new-access");
  assert.equal(marked, 0);
});

test("a worker that loses the refresh lease waits for the winner's committed token instead of failing", async () => {
  const expired: QuickBooksStoredToken = { accessToken: "old-access", refreshToken: "old-refresh", tokenType: "bearer", accessTokenExpiresAt: "2026-09-21T11:00:00.000Z", version: 2 };
  let loads = 0;
  let refreshes = 0;
  const repository: QuickBooksTokenRepository = {
    async load() { loads += 1; return loads < 4 ? expired : { ...rotated, version: 3 }; },
    async save() { throw new Error("loser must not save"); },
    async revoke() { throw new Error("unused"); },
    async markNeedsReconnect() { throw new Error("unused"); },
  };
  const sleeps: number[] = [];
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: { async refreshToken() { refreshes += 1; return rotated; }, async revokeToken() { return {}; } },
    now: () => current,
    refreshLease: { async acquire() { return false; }, async release() { throw new Error("not held"); } },
    refreshLeaseOwnerId: "worker-b",
    refreshLeasePollMs: 5,
    sleep: async ms => { sleeps.push(ms); },
  });
  assert.equal(await manager.getAccessToken(scope), "new-access");
  assert.equal(refreshes, 0);
  assert.deepEqual(sleeps, [5, 5]);

  const stuck = createQuickBooksTokenManager({
    repository: { ...repository, async load() { return expired; } },
    oauth: { async refreshToken() { refreshes += 1; return rotated; }, async revokeToken() { return {}; } },
    now: () => current,
    refreshLease: { async acquire() { return false; }, async release() {} },
    refreshLeaseOwnerId: "worker-c",
    refreshLeaseWaitMs: 0,
  });
  await assert.rejects(() => stuck.getAccessToken(scope), (error: unknown) => error instanceof QuickBooksIntegrationError && error.code === "quickbooks_token_store" && error.retryable);
  assert.equal(refreshes, 0);
});
