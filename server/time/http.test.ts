import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createCompanyDemoApp } from "../company/demo";
import { createTimeStore } from "./store";
import { normalizeTimeEntry, normalizeTimeJobcode, normalizeTimeUser } from "./normalize";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "production" as const,
  providerCompanyId: "time-company",
};
const modified = "2026-09-21T12:00:00.000Z";

test("Time HTTP requires an explicit environment and shares scoped list and command receipts", async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${scope.organizationId}/time`;
  try {
    await fixture.database.db.query(
      "INSERT INTO company_contacts (id,organization_id,kind,display_name) VALUES ($1,$2,'person','Time employee')",
      ["55000000-0000-4000-8000-000000000099", scope.organizationId],
    );
    const store = createTimeStore(fixture.database.executor, () => new Date("2026-09-21T13:00:00.000Z"));
    await store.upsertUser(scope, normalizeTimeUser(scope, {
      id: "employee-1", first_name: "Time", last_name: "Employee", active: true, submitted_to: "2026-09-21", last_modified: modified,
    }), modified);
    await store.upsertJobcode(scope, normalizeTimeJobcode(scope, {
      id: "job-1", name: "Turnover", active: true, billable: false, last_modified: modified,
    }), modified);
    const normalized = normalizeTimeEntry(scope, {
      id: "timesheet-1", user_id: "employee-1", jobcode_id: "job-1", type: "regular",
      start: "2026-09-21T09:00:00-04:00", end: "2026-09-21T11:00:00-04:00", date: "2026-09-21", duration: 7_200,
      tz: -4, tz_str: "America/New_York", active: true, locked: 0, last_modified: modified,
    });
    await store.upsertEntry(scope, normalized, modified);
    const seed = await store.listEntries({
      scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId },
      environment: scope.environment,
      providerCompanyId: scope.providerCompanyId,
      limit: 50,
    });
    const entryId = seed.items[0]?.id;
    assert.ok(entryId);

    const missingEnvironment = await fetch(`${base}/entries?legalEntityId=${scope.legalEntityId}&providerCompanyId=${scope.providerCompanyId}`);
    assert.equal(missingEnvironment.status, 400);

    const listResponse = await fetch(`${base}/entries?legalEntityId=${scope.legalEntityId}&environment=production&providerCompanyId=${scope.providerCompanyId}&limit=50`);
    assert.equal(listResponse.status, 200, await listResponse.clone().text());
    const list = await listResponse.json() as { items: Array<{ id: string; providerTimesheetId: string; source: { environment: string } }> };
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0]?.id, entryId);
    assert.equal(list.items[0]?.providerTimesheetId, "timesheet-1");
    assert.equal(list.items[0]?.source.environment, "production");

    const operationId = randomUUID();
    const envelope = {
      operationId,
      idempotencyKey: `time-http:${operationId}`,
      scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId },
      payload: {
        environment: scope.environment,
        providerCompanyId: scope.providerCompanyId,
        timesheetId: entryId,
        expectedCorrectionRevision: 0,
        type: "regular",
        start: "2026-09-21T09:00:00-04:00",
        end: "2026-09-21T10:00:00-04:00",
        date: "2026-09-21",
        durationSeconds: 3_600,
        timezoneOffsetMinutes: -240,
        timezoneName: "America/New_York",
        notes: "corrected through HTTP",
        reason: "Manager correction",
      },
    };
    const post = () => fetch(`${origin}/api/company/${scope.organizationId}/time-commands/time.correct_timesheet`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rent-ops-csrf": "rent-ops-demo-csrf-token-local-only-20260817" },
      body: JSON.stringify(envelope),
    });
    const commandResponse = await post();
    assert.equal(commandResponse.status, 200, await commandResponse.clone().text());
    const receipt = await commandResponse.json() as { operationId: string; state: string; affectedRecordIds: string[] };
    assert.equal(receipt.operationId, operationId);
    assert.equal(receipt.state, "saved_in_rops");
    assert.deepEqual(receipt.affectedRecordIds, [entryId]);
    assert.deepEqual(await (await post()).json(), receipt);

    const correctedResponse = await fetch(`${base}/entries?legalEntityId=${scope.legalEntityId}&environment=production&providerCompanyId=${scope.providerCompanyId}&reviewState=corrected&limit=50`);
    assert.equal(correctedResponse.status, 200);
    const corrected = await correctedResponse.json() as { items: Array<{ durationSeconds: number; reviewState: string }> };
    assert.equal(corrected.items[0]?.durationSeconds, 3_600);
    assert.equal(corrected.items[0]?.reviewState, "corrected");
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
