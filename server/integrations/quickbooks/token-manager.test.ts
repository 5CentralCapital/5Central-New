import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksTokenManager } from "./token-manager";
import type { QuickBooksOAuthTokenSet, QuickBooksStoredToken, QuickBooksTokenRepository } from "../../../shared/accounting/quickbooks";

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
  };
  const manager = createQuickBooksTokenManager({
    repository,
    oauth: { async refreshToken() { throw new Error("unused"); }, async revokeToken(token) { calls.push(`provider-revoke:${token}`); return {}; } },
  });
  await manager.disconnect(scope);
  assert.deepEqual(calls, ["provider-revoke:refresh", "local-revoke"]);
});
