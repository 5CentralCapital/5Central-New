import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTimeEntry, normalizeTimeJobcode, normalizeTimeUser, normalizeTimeDeleted } from "./normalize";
import { createTimeStore } from "./store";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createTimeServices } from "./service";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "production" as const, providerCompanyId: "time-company" };
const CONTACT_ID = "55000000-0000-4000-8000-000000000099";
const modified = "2026-09-21T12:00:00.000Z";

async function timeSchema(database: Awaited<ReturnType<typeof createSyntheticCompanyDatabase>>): Promise<void> {
  await database.db.query("INSERT INTO company_contacts (id,organization_id,kind,display_name) VALUES ($1,$2,'person','Time employee')", [CONTACT_ID, SYNTHETIC_COMPANY.organizationId]);
}

function providerEntry(duration = 7_200, lastModified = modified, overrides: Record<string, unknown> = {}): ReturnType<typeof normalizeTimeEntry> {
  return normalizeTimeEntry(scope, { id: "timesheet-1", user_id: "employee-1", jobcode_id: "job-1", type: "regular", start: "2026-09-21T09:00:00-04:00", end: "2026-09-21T11:00:00-04:00", date: "2026-09-21", duration, tz: -4, tz_str: "America/New_York", active: true, locked: 0, last_modified: lastModified, notes: "shift", ...overrides });
}

test("time persistence mirrors source records, maps them, estimates exact cents, and preserves payroll separation", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    await timeSchema(database);
    const store = createTimeStore(database.executor, () => new Date("2026-09-21T13:00:00.000Z"));
    await store.upsertUser(scope, normalizeTimeUser(scope, { id: "employee-1", first_name: "Time", last_name: "Employee", active: true, submitted_to: "2026-09-21", approved_to: null, last_modified: modified }), modified);
    await store.upsertJobcode(scope, normalizeTimeJobcode(scope, { id: "job-1", name: "Turnover", active: true, billable: false, last_modified: modified }), modified);
    const entry = providerEntry();
    await store.upsertEntry(scope, entry, modified);
    const beforeMapping = await store.listEntries({ scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, environment: scope.environment, providerCompanyId: scope.providerCompanyId, limit: 50 });
    assert.equal(beforeMapping.items.length, 1);
    assert.equal(beforeMapping.items[0]?.mappingStatus, "unmapped_employee");
    assert.equal(beforeMapping.items[0]?.postedPayrollCents, null);
    const employee = await store.mapEmployee({ scope, providerUserId: "employee-1", contactId: CONTACT_ID, effectiveFrom: "2026-01-01", effectiveTo: null, hourlyRateCents: "2250", currency: "USD", actorId: SYNTHETIC_COMPANY.actorId, operationId: "65000000-0000-4000-8000-000000000099" });
    assert.equal(employee.hourlyRateCents, "2250");
    await store.mapJobcode({ scope, providerJobcodeId: "job-1", propertyId: SYNTHETIC_COMPANY.propertyId, projectId: null, costCode: "TURN", actorId: SYNTHETIC_COMPANY.actorId, operationId: "65000000-0000-4000-8000-000000000100" });
    const transaction = database.executor.transaction!;
    const approved = await transaction(async executor => store.forExecutor(executor).reviewTimesheet({ scope, timesheetId: beforeMapping.items[0]!.id, action: "approve", actorId: SYNTHETIC_COMPANY.actorId, operationId: "65000000-0000-4000-8000-000000000101" }));
    assert.equal(approved.reviewState, "approved");
    assert.equal(approved.estimatedLaborCostCents, "4500");
    assert.equal(approved.postedPayrollCents, null);
    const estimate = await database.db.query<{ labor_cost_cents: string }>("SELECT labor_cost_cents::text FROM time_labor_estimates WHERE timesheet_id=$1", [beforeMapping.items[0]!.id]);
    assert.equal(estimate.rows[0]?.labor_cost_cents, "4500");
  } finally { await database.close(); }
});

test("time persistence rejects a second active clock-in and records deletion tombstones", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    await timeSchema(database);
    const store = createTimeStore(database.executor);
    const active = normalizeTimeEntry(scope, { id: "timesheet-active", user_id: "employee-2", jobcode_id: "job-1", type: "regular", start: "2026-09-21T09:00:00-04:00", date: "2026-09-21", duration: 0, tz: -4, tz_str: "America/New_York", on_the_clock: true, active: true, last_modified: modified });
    await store.upsertEntry(scope, active, modified);
    const second = normalizeTimeEntry(scope, { id: "timesheet-active-2", user_id: "employee-2", jobcode_id: "job-1", type: "regular", start: "2026-09-21T10:00:00-04:00", date: "2026-09-21", duration: 0, tz: -4, tz_str: "America/New_York", on_the_clock: true, active: true, last_modified: modified });
    await assert.rejects(() => store.upsertEntry(scope, second, modified), /more than one active timesheet/);
    await store.applyDeleted(scope, normalizeTimeDeleted(scope, { id: "timesheet-active", last_modified: "2026-09-21T13:30:00.000Z", reason: "removed" }), "2026-09-21T13:31:00.000Z");
    const deleted = await database.db.query<{ provider_active: boolean; deleted_at: string | null }>("SELECT provider_active,deleted_at FROM time_timesheets WHERE provider_timesheet_id='timesheet-active'");
    assert.equal(deleted.rows[0]?.provider_active, false);
    assert.ok(deleted.rows[0]?.deleted_at);
    const tombstones = await database.db.query<{ count: number }>("SELECT count(*)::int AS count FROM time_timesheet_deletion_tombstones WHERE provider_timesheet_id='timesheet-active'");
    assert.equal(tombstones.rows[0]?.count, 1);
  } finally { await database.close(); }
});

test("time source revisions are idempotent and a changed provider body reopens approval", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    await timeSchema(database);
    const store = createTimeStore(database.executor);
    const first = providerEntry();
    await store.upsertEntry(scope, first, modified);
    const initial = await database.db.query<{ current_revision_id: string }>("SELECT current_revision_id FROM time_timesheets WHERE provider_timesheet_id=$1", [first.providerTimesheetId]);
    const initialRevision = initial.rows[0]?.current_revision_id;
    assert.ok(initialRevision);

    await database.db.query("UPDATE time_timesheets SET review_state='approved' WHERE provider_timesheet_id=$1", [first.providerTimesheetId]);
    const repeated = await store.upsertEntry(scope, first, modified);
    assert.equal(repeated.conflict, "none");
    const afterRepeat = await database.db.query<{ current_revision_id: string; review_state: string; revisions: number }>(
      "SELECT t.current_revision_id,t.review_state,(SELECT count(*)::int FROM time_timesheet_revisions r WHERE r.provider_timesheet_id=t.provider_timesheet_id) AS revisions FROM time_timesheets t WHERE t.provider_timesheet_id=$1",
      [first.providerTimesheetId],
    );
    assert.equal(afterRepeat.rows[0]?.current_revision_id, initialRevision);
    assert.equal(afterRepeat.rows[0]?.review_state, "approved");
    assert.equal(afterRepeat.rows[0]?.revisions, 1);

    const revised = providerEntry(7_200, "2026-09-21T13:00:00.000Z", { notes: "provider revision" });
    await store.upsertEntry(scope, revised, "2026-09-21T13:01:00.000Z");
    const afterRevision = await database.db.query<{ current_revision_id: string; review_state: string; revisions: number; notes: string }>(
      "SELECT t.current_revision_id,t.review_state,t.notes,(SELECT count(*)::int FROM time_timesheet_revisions r WHERE r.provider_timesheet_id=t.provider_timesheet_id) AS revisions FROM time_timesheets t WHERE t.provider_timesheet_id=$1",
      [first.providerTimesheetId],
    );
    assert.notEqual(afterRevision.rows[0]?.current_revision_id, initialRevision);
    assert.equal(afterRevision.rows[0]?.review_state, "needs_review");
    assert.equal(afterRevision.rows[0]?.revisions, 2);
    assert.equal(afterRevision.rows[0]?.notes, "provider revision");
  } finally { await database.close(); }
});

test("time tombstones and source versions prevent stale provider pages from overwriting current data", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    await timeSchema(database);
    const store = createTimeStore(database.executor);
    await store.upsertUser(scope, normalizeTimeUser(scope, { id: "employee-1", first_name: "New", last_name: "Name", active: true, last_modified: "2026-09-21T13:00:00.000Z" }), "2026-09-21T13:00:00.000Z");
    await store.upsertUser(scope, normalizeTimeUser(scope, { id: "employee-1", first_name: "Old", last_name: "Name", active: true, last_modified: modified }), modified);
    const users = await store.listUsers(scope);
    assert.equal(users.find(user => user.providerUserId === "employee-1")?.firstName, "New");

    await store.upsertJobcode(scope, normalizeTimeJobcode(scope, { id: "job-1", name: "New job", active: true, last_modified: "2026-09-21T13:00:00.000Z" }), "2026-09-21T13:00:00.000Z");
    await store.upsertJobcode(scope, normalizeTimeJobcode(scope, { id: "job-1", name: "Old job", active: true, last_modified: modified }), modified);
    const jobcodes = await store.listJobcodes(scope);
    assert.equal(jobcodes.find(jobcode => jobcode.providerJobcodeId === "job-1")?.name, "New job");

    const live = providerEntry();
    await store.upsertEntry(scope, live, modified);
    await store.applyDeleted(scope, normalizeTimeDeleted(scope, { id: live.providerTimesheetId, last_modified: "2026-09-21T13:00:00.000Z", reason: "removed" }), "2026-09-21T13:01:00.000Z");
    const stale = providerEntry(7_200, "2026-09-21T12:30:00.000Z", { notes: "stale page" });
    const applied = await store.upsertEntry(scope, stale, "2026-09-21T13:02:00.000Z");
    assert.equal(applied.conflict, "deleted");
    const deleted = await database.db.query<{ provider_active: boolean; revisions: number }>(
      "SELECT t.provider_active,(SELECT count(*)::int FROM time_timesheet_revisions r WHERE r.provider_timesheet_id=t.provider_timesheet_id) AS revisions FROM time_timesheets t WHERE t.provider_timesheet_id=$1",
      [live.providerTimesheetId],
    );
    assert.equal(deleted.rows[0]?.provider_active, false);
    assert.equal(deleted.rows[0]?.revisions, 1);

    const newerLive = providerEntry(7_200, "2026-09-21T14:00:00.000Z", { id: "timesheet-newer" });
    await store.upsertEntry(scope, newerLive, "2026-09-21T14:01:00.000Z");
    await store.applyDeleted(scope, normalizeTimeDeleted(scope, { id: newerLive.providerTimesheetId, last_modified: "2026-09-21T13:00:00.000Z", reason: "stale delete" }), "2026-09-21T14:02:00.000Z");
    const remainsActive = await database.db.query<{ provider_active: boolean; tombstones: number }>(
      "SELECT t.provider_active,(SELECT count(*)::int FROM time_timesheet_deletion_tombstones d WHERE d.provider_timesheet_id=t.provider_timesheet_id) AS tombstones FROM time_timesheets t WHERE t.provider_timesheet_id=$1",
      [newerLive.providerTimesheetId],
    );
    assert.equal(remainsActive.rows[0]?.provider_active, true);
    assert.equal(remainsActive.rows[0]?.tombstones, 0);
  } finally { await database.close(); }
});

test("time sync run idempotency returns the persisted run on replay", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const store = createTimeStore(database.executor);
    const first = await store.beginSyncRun(scope, "time-sync-replay");
    const replay = await store.beginSyncRun(scope, "time-sync-replay");
    assert.equal(replay, first);
    const count = await database.db.query<{ count: number }>("SELECT count(*)::int AS count FROM time_sync_runs WHERE idempotency_key=$1", ["time-sync-replay"]);
    const persisted = await database.db.query<{ id: string }>("SELECT id::text AS id FROM time_sync_runs WHERE idempotency_key=$1", ["time-sync-replay"]);
    assert.equal(count.rows[0]?.count, 1);
    assert.equal(persisted.rows[0]?.id, first);
  } finally { await database.close(); }
});

test("a property-only grant cannot approve entity-wide time through the command runner", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    await timeSchema(database);
    const store = createTimeStore(database.executor);
    await store.upsertEntry(scope, providerEntry(), modified);
    await store.mapEmployee({ scope, providerUserId: "employee-1", contactId: CONTACT_ID, effectiveFrom: "2026-01-01", effectiveTo: null, hourlyRateCents: "2250", currency: "USD", actorId: SYNTHETIC_COMPANY.actorId, operationId: "65000000-0000-4000-8000-000000000199" });
    await store.mapJobcode({ scope, providerJobcodeId: "job-1", propertyId: null, projectId: null, costCode: null, actorId: SYNTHETIC_COMPANY.actorId, operationId: "65000000-0000-4000-8000-000000000200" });
    const timesheet = await database.db.query<{ id: string }>("SELECT id FROM time_timesheets WHERE provider_timesheet_id='timesheet-1'");
    const actorId = "property-pm";
    await database.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id,property_id) VALUES ('40000000-0000-4000-8000-000000000077',$1,$2,'project_manager',$3,$4)", [SYNTHETIC_COMPANY.organizationId, actorId, SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.propertyId]);
    const resolvePrincipal = (executor = database.executor) => loadAuthenticatedPrincipal(executor, { actorId, organizationId: SYNTHETIC_COMPANY.organizationId, role: "project_manager" });
    const services = createTimeServices(database.executor, { env: {} });
    const principal = await resolvePrincipal();
    await assert.rejects(() => services.commands.execute("time.review_timesheet", {
      operationId: "66000000-0000-4000-8000-000000000001", idempotencyKey: "time-property-scope-1",
      scope: { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, propertyId: SYNTHETIC_COMPANY.propertyId },
      payload: { environment: scope.environment, providerCompanyId: scope.providerCompanyId, timesheetId: timesheet.rows[0]!.id, action: "approve" },
    }, { principal, resolvePrincipal, transport: attestTransport("web") }), /scope level/);
    const state = await database.db.query<{ review_state: string }>("SELECT review_state FROM time_timesheets WHERE provider_timesheet_id='timesheet-1'");
    assert.notEqual(state.rows[0]?.review_state, "approved");
  } finally { await database.close(); }
});
