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
    const result = await service.sync(scope, { maxPages: 2, startDate: "2026-09-01", endDate: "2026-09-21" });
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

test("a Time sync with no provider changes keeps each stream's modified-since checkpoint", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    let userPages: Record<string, Record<string, unknown>> = { one: { id: "employee-1", first_name: "Valid", last_name: "Employee", active: true, last_modified: "2026-09-21T12:00:00.000Z" } };
    const requestedSince: (string | undefined)[] = [];
    const client: QuickBooksTimeClient = {
      async getPage(resource, request) {
        if (resource === "users") { requestedSince.push(request.modifiedSince); return { more: false, results: userPages }; }
        return { more: false, results: {} };
      },
    };
    const service = createTimeSyncService({ executor: database.executor, client, getAccessToken: async () => "synthetic-access-token", now: () => new Date("2026-09-21T13:00:00.000Z") });
    await service.sync(scope, { maxPages: 2, startDate: "2026-09-01", endDate: "2026-09-21" });
    userPages = {};
    await service.sync(scope, { maxPages: 2, startDate: "2026-09-01", endDate: "2026-09-21" });
    const checkpoint = await createTimeStore(database.executor).readCheckpoint(scope, "users");
    assert.equal(checkpoint?.modifiedSince, "2026-09-21T12:00:00.000Z");
    await service.sync(scope, { maxPages: 2, startDate: "2026-09-01", endDate: "2026-09-21" });
    assert.deepEqual(requestedSince, [undefined, "2026-09-21T11:59:59.000Z", "2026-09-21T11:59:59.000Z"]);
  } finally {
    await database.close();
  }
});

test("the first Time sync requires an explicit bounded start date", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    let providerCalls = 0;
    const client: QuickBooksTimeClient = {
      async getPage() { providerCalls += 1; return { more: false, results: {} }; },
    };
    const service = createTimeSyncService({ executor: database.executor, client, getAccessToken: async () => "synthetic-access-token", now: () => new Date("2026-09-21T13:00:00.000Z") });
    await assert.rejects(() => service.sync(scope), /initial sync requires a start date/);
    assert.equal(providerCalls, 0, "invalid range input is rejected before any provider read");
  } finally {
    await database.close();
  }
});

test("an initial Time range defaults its end date to the New York operating date", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const rangeEnds: string[] = [];
    const client: QuickBooksTimeClient = {
      async getPage(resource, request) {
        if (resource === "timesheets" || resource === "timesheets_deleted") rangeEnds.push(request.endDate ?? "");
        return { more: false, results: {} };
      },
    };
    const service = createTimeSyncService({ executor: database.executor, client, getAccessToken: async () => "synthetic-access-token", now: () => new Date("2026-09-22T02:00:00.000Z") });
    await service.sync(scope, { maxPages: 2, startDate: "2026-09-01" });
    assert.deepEqual(rangeEnds, ["2026-09-21", "2026-09-21"]);
  } finally {
    await database.close();
  }
});
