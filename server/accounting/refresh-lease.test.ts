import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQuickBooksTokenRepository } from "./connection-store";
import { createQboTokenCipher } from "./token-crypto";
import { PostgresQuickBooksRefreshLease } from "./refresh-lease";
import { createQuickBooksTokenManager } from "../integrations/quickbooks/token-manager";
import type { QuickBooksOAuthTokenSet } from "../../shared/accounting/quickbooks";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "123456" };

test("two workers with separate repositories refresh an expired token exactly once and share the rotated token", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const cipher = createQboTokenCipher(Buffer.alloc(32, 7));
    const seedRepository = createQuickBooksTokenRepository(synthetic.executor, cipher);
    await seedRepository.save(scope, {
      accessToken: "access-expired",
      refreshToken: "refresh-original",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const refreshedWith: string[] = [];
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    let providerEntered!: () => void;
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    const oauth = {
      async refreshToken(refreshToken: string): Promise<QuickBooksOAuthTokenSet> {
        refreshedWith.push(refreshToken);
        providerEntered();
        await providerGate;
        return { accessToken: "access-rotated", refreshToken: "refresh-rotated", tokenType: "bearer", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      },
      async revokeToken() { return {}; },
    };
    const worker = (owner: string) => createQuickBooksTokenManager({
      oauth,
      repository: createQuickBooksTokenRepository(synthetic.executor, cipher),
      refreshLease: new PostgresQuickBooksRefreshLease(synthetic.executor),
      refreshLeaseOwnerId: owner,
      refreshLeasePollMs: 5,
      refreshLeaseWaitMs: 5_000,
    });
    const workerA = worker("worker-a");
    const workerB = worker("worker-b");
    const first = workerA.getAccessToken(scope);
    await entered;
    const second = workerB.getAccessToken(scope);
    await new Promise(resolve => setTimeout(resolve, 30));
    releaseProvider();
    assert.deepEqual(await Promise.all([first, second]), ["access-rotated", "access-rotated"]);
    assert.deepEqual(refreshedWith, ["refresh-original"], "only the lease winner calls Intuit");
    const stored = await seedRepository.load(scope);
    assert.equal(stored?.refreshToken, "refresh-rotated");
    assert.equal(stored?.version, 2);
    const leases = await synthetic.db.query<{ count: number }>("SELECT count(*)::int AS count FROM accounting_qbo_refresh_leases");
    assert.equal(leases.rows[0]?.count, 0, "the winner releases its lease");
  } finally {
    await synthetic.close();
  }
});

test("a refresh save is fenced by the lease owner and the version it read", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const cipher = createQboTokenCipher(Buffer.alloc(32, 7));
    const repository = createQuickBooksTokenRepository(synthetic.executor, cipher);
    const base = { tokenType: "bearer" as const, accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const saved = await repository.save(scope, { ...base, accessToken: "a1", refreshToken: "r1" });
    const lease = new PostgresQuickBooksRefreshLease(synthetic.executor);
    assert.equal(await lease.acquire(scope, "worker-a", 60_000), true);
    assert.equal(await lease.acquire(scope, "worker-b", 60_000), false);
    await assert.rejects(() => repository.saveWithLease(scope, { ...base, accessToken: "a2", refreshToken: "r2" }, saved.version!, "worker-b"), /changed during token rotation/);
    const rotated = await repository.saveWithLease(scope, { ...base, accessToken: "a2", refreshToken: "r2" }, saved.version!, "worker-a");
    await assert.rejects(() => repository.saveWithLease(scope, { ...base, accessToken: "a3", refreshToken: "r3" }, saved.version!, "worker-a"), /changed during token rotation/);
    assert.equal((await repository.load(scope))?.refreshToken, "r2");
    assert.equal(rotated.version, saved.version! + 1);
  } finally {
    await synthetic.close();
  }
});
