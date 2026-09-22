import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { PostgresTimeRefreshLease } from "./refresh-lease";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "production" as const,
  providerCompanyId: "time-company",
};

test("Time refresh lease is scoped, fenced, and releasable", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const now = new Date("2026-09-21T12:00:00.000Z");
    const lease = new PostgresTimeRefreshLease(database.executor, () => now);
    assert.equal(await lease.acquire(scope, "worker-1", 120_000), true);
    assert.equal(await lease.acquire(scope, "worker-2", 120_000), false);
    await lease.release(scope, "worker-1");
    assert.equal(await lease.acquire(scope, "worker-2", 120_000), true);
    await lease.release(scope, "worker-2");
    const rows = await database.db.query<{ count: number }>("SELECT count(*)::int AS count FROM time_refresh_leases");
    assert.equal(rows.rows[0]?.count, 0);
  } finally {
    await database.close();
  }
});
