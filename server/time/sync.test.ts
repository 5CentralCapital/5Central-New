import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { TimeConnectionScope } from "../../shared/time";
import { createTimeStore } from "./store";
import { createTimeSyncService } from "./sync";
import type { QuickBooksTimeClient } from "./provider";

const scope: TimeConnectionScope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "production",
  providerCompanyId: "time-company",
};

test("Time sync isolates an invalid provider object and preserves valid objects in the same run", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const client: QuickBooksTimeClient = {
      async getPage(resource) {
        if (resource === "users") {
          return {
            more: false,
            results: {
              invalid: { id: "invalid-user" },
              valid: { id: "employee-1", first_name: "Valid", last_name: "Employee", active: true, last_modified: "2026-09-21T12:00:00.000Z" },
            },
          };
        }
        return { more: false, results: {} };
      },
    };
    const service = createTimeSyncService({
      executor: database.executor,
      client,
      getAccessToken: async () => "synthetic-access-token",
      now: () => new Date("2026-09-21T13:00:00.000Z"),
    });
    const result = await service.sync(scope, { maxPages: 2 });
    assert.equal(result.status, "partial");
    const users = await createTimeStore(database.executor).listUsers(scope);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.providerUserId, "employee-1");
    assert.equal(result.streams.find(stream => stream.stream === "users")?.status, "partial");
    assert.match(result.streams.find(stream => stream.stream === "users")?.reason ?? "", /last_modified/i);
  } finally {
    await database.close();
  }
});
