import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQuickBooksTokenRepository } from "./connection-store";
import { createQboTokenCipher } from "./token-crypto";
import { PostgresQuickBooksRefreshLease } from "./refresh-lease";
import { disconnectQuickBooksConnection } from "./disconnect";
import { AccountingError } from "./errors";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "123456" };
const token = { accessToken: "access-1", refreshToken: "refresh-1", tokenType: "bearer" as const, accessTokenExpiresAt: "2027-01-01T00:00:00.000Z" };

test("disconnect does not revoke while another worker holds the refresh lease, then revokes the latest token under the lease", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const cipher = createQboTokenCipher(Buffer.alloc(32, 7));
    const repository = createQuickBooksTokenRepository(synthetic.executor, cipher);
    await repository.save(scope, token);
    const revoked: string[] = [];
    const oauth = { async revokeToken(value: string) { revoked.push(value); return { intuitTid: "tid-revoke" }; } };
    const lease = new PostgresQuickBooksRefreshLease(synthetic.executor);
    assert.equal(await lease.acquire(scope, "worker-refreshing", 60_000), true);
    await assert.rejects(
      () => disconnectQuickBooksConnection({ executor: synthetic.executor, cipher, oauth }, { actorId: SYNTHETIC_COMPANY.actorId, channel: "web", scope }),
      (error: unknown) => error instanceof AccountingError && error.details.reason === "qbo_disconnect_unconfirmed" && error.details.retryable === true,
    );
    assert.deepEqual(revoked, [], "no provider revoke while a rotation may be in flight");
    assert.equal((await repository.load(scope))?.refreshToken, "refresh-1");

    // The refresher commits a rotation under its lease and releases it.
    const current = await repository.load(scope);
    await repository.saveWithLease(scope, { ...token, accessToken: "access-2", refreshToken: "refresh-2" }, current!.version!, "worker-refreshing");
    await lease.release(scope, "worker-refreshing");

    const result = await disconnectQuickBooksConnection({ executor: synthetic.executor, cipher, oauth }, { actorId: SYNTHETIC_COMPANY.actorId, channel: "web", scope });
    assert.equal(result.providerOutcome, "revoked");
    assert.deepEqual(revoked, ["refresh-2"]);
    assert.equal(await repository.load(scope), null);
    const leases = await synthetic.db.query<{ count: number }>("SELECT count(*)::int AS count FROM accounting_qbo_refresh_leases");
    assert.equal(leases.rows[0]?.count, 0);
  } finally {
    await synthetic.close();
  }
});

test("a version-fenced revoke never wipes a credential newer than the one revoked at Intuit", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const repository = createQuickBooksTokenRepository(synthetic.executor, createQboTokenCipher(Buffer.alloc(32, 7)));
    const first = await repository.save(scope, token);
    await repository.save(scope, { ...token, refreshToken: "refresh-2" }, first.version);
    await assert.rejects(() => repository.revoke(scope, first.version), /changed before it could be disconnected/);
    assert.equal((await repository.load(scope))?.refreshToken, "refresh-2");
    await repository.revoke(scope, first.version! + 1);
    assert.equal(await repository.load(scope), null);
  } finally {
    await synthetic.close();
  }
});
