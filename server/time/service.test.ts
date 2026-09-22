import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createTimeServices, createTransactionBoundTimeReadPort } from "./service";
import type { StoredTimeToken, TimeTokenRepository } from "./connection-store";
import type { TimeRefreshLease } from "./refresh-lease";
import type { TimeConnectionScope } from "../../shared/time";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { loadAuthenticatedPrincipal } from "../company/authorization";

const scope: TimeConnectionScope = {
  organizationId: "10000000-0000-4000-8000-000000000001" as TimeConnectionScope["organizationId"],
  legalEntityId: "20000000-0000-4000-8000-000000000001" as TimeConnectionScope["legalEntityId"],
  environment: "production",
  providerCompanyId: "time-company",
};
const now = new Date("2026-09-21T12:00:00.000Z");

test("QuickBooks Time refresh uses one durable lease winner and rereads the committed token", async () => {
  let stored: StoredTimeToken = {
    accessToken: "expired-access",
    refreshToken: "refresh-1",
    tokenType: "bearer",
    accessTokenExpiresAt: "2026-09-21T11:59:00.000Z",
    refreshTokenExpiresAt: "2026-10-21T12:00:00.000Z",
    version: 1,
    updatedAt: "2026-09-21T11:00:00.000Z",
  };
  let leaseOwner: string | null = null;
  let refreshCalls = 0;
  const repository: TimeTokenRepository = {
    load: async () => stored,
    save: async (_scope, token, expectedVersion) => {
      if (expectedVersion !== undefined && expectedVersion !== stored.version) throw new Error("version conflict");
      stored = { ...token, version: stored.version + 1, updatedAt: now.toISOString() };
      return stored;
    },
    saveWithLease: async (_scope, token, expectedVersion, ownerId) => {
      if (leaseOwner !== ownerId || expectedVersion !== stored.version) throw new Error("fence conflict");
      stored = { ...token, version: stored.version + 1, updatedAt: now.toISOString() };
      return stored;
    },
    saveNewConnection: async (_scope, token) => { stored = { ...token, version: stored.version + 1, updatedAt: now.toISOString() }; return stored; },
    revoke: async () => undefined,
  };
  const lease: TimeRefreshLease = {
    acquire: async (_scope, ownerId) => {
      if (leaseOwner !== null) return false;
      leaseOwner = ownerId;
      return true;
    },
    release: async (_scope, ownerId) => { if (leaseOwner === ownerId) leaseOwner = null; },
  };
  const executor: RentOpsQueryExecutor = {
    query: async () => ({ rows: [] }),
    transaction: async work => work(executor),
  };
  const makeServices = (prefix: string) => createTimeServices(executor, {
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://rops.example.test/time/callback",
    environment: "production",
    now: () => now,
    tokenRepository: repository,
    refreshLease: lease,
    refreshLeaseOwnerId: prefix,
    transport: async request => {
      if (request.method !== "POST") return { status: 200, body: "{}" };
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
      return { status: 200, body: JSON.stringify({ access_token: "rotated-access", refresh_token: "refresh-2", expires_in: 3_600, refresh_expires_in: 86_400, company_id: scope.providerCompanyId }) };
    },
  });
  const services = makeServices("test-time-refresh");
  assert.equal(services.qbt.status, "configured");
  if (services.qbt.status !== "configured") return;
  const [first, second] = await Promise.all([services.qbt.getAccessToken(scope), services.qbt.getAccessToken(scope)]);
  assert.equal(first, "rotated-access");
  assert.equal(second, "rotated-access");
  assert.equal(refreshCalls, 1);
  assert.equal(leaseOwner, null);
  assert.equal(stored.version, 2);

  stored = { ...stored, accessToken: "expired-again", refreshToken: "refresh-2", accessTokenExpiresAt: "2026-09-21T11:59:00.000Z", version: 3 };
  refreshCalls = 0;
  const servicesA = makeServices("test-time-refresh-a");
  const servicesB = makeServices("test-time-refresh-b");
  assert.equal(servicesA.qbt.status, "configured");
  assert.equal(servicesB.qbt.status, "configured");
  if (servicesA.qbt.status !== "configured" || servicesB.qbt.status !== "configured") return;
  const [third, fourth] = await Promise.all([servicesA.qbt.getAccessToken(scope), servicesB.qbt.getAccessToken(scope)]);
  assert.equal(third, "rotated-access");
  assert.equal(fourth, "rotated-access");
  assert.equal(refreshCalls, 1);
  assert.equal(stored.version, 4);
});

test("transaction-bound Time reads reload active grants without opening a nested transaction", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const runtime = await createSyntheticRuntimeExecutor(fixture.db);
  const connectionScope = {
    organizationId: SYNTHETIC_COMPANY.organizationId as TimeConnectionScope["organizationId"],
    legalEntityId: SYNTHETIC_COMPANY.entityId as TimeConnectionScope["legalEntityId"],
  };
  try {
    const principal = await loadAuthenticatedPrincipal(runtime, { actorId: SYNTHETIC_COMPANY.actorId, organizationId: SYNTHETIC_COMPANY.organizationId, role: "admin" });
    const first = await runtime.transaction!(transaction => createTransactionBoundTimeReadPort(transaction).listConnections(principal, connectionScope));
    assert.deepEqual(first, []);

    // The principal object is intentionally stale. A new active transaction
    // must observe the revocation before the read is allowed to proceed.
    await fixture.db.query("UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2 AND revoked_at IS NULL", [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.actorId]);
    await assert.rejects(
      () => runtime.transaction!(transaction => createTransactionBoundTimeReadPort(transaction).listConnections(principal, connectionScope)),
      /no active company grant/,
    );
  } finally {
    await fixture.close();
  }
});
