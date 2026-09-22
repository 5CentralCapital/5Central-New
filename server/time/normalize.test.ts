import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTimeDeleted, normalizeTimeEntry, normalizeTimeJobcode, normalizeTimeUser } from "./normalize";

const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "production" as const, providerCompanyId: "time-company" };
const modified = "2026-11-01T07:00:00.000Z";

test("normalizes regular time across midnight and a daylight-saving fallback with explicit offsets", () => {
  const entry = normalizeTimeEntry(scope, {
    id: "timesheet-1", user_id: "employee-1", jobcode_id: "job-1", type: "regular",
    start: "2026-10-31T23:30:00-04:00", end: "2026-11-01T01:00:00-05:00", date: "2026-10-31", duration: 9_000,
    tz: -4, tz_str: "America/New_York", on_the_clock: false, locked: 1, active: true, notes: "fallback shift", last_modified: modified,
  });
  assert.equal(entry.type, "regular");
  assert.equal(entry.durationSeconds, 9_000);
  assert.equal(entry.conflict, "none");
  assert.equal(entry.timezoneOffsetMinutes, -240);
  assert.equal(entry.timezoneName, "America/New_York");
  assert.equal(entry.locked, true);
  assert.equal(entry.onTheClock, false);
});

test("keeps manual date and duration separate from regular timestamps", () => {
  const entry = normalizeTimeEntry(scope, { id: "timesheet-manual", user_id: "employee-1", jobcode_id: "job-1", type: "manual", date: "2026-09-21", duration: 5_400, tz: -4, tz_str: "America/New_York", locked: 0, last_modified: modified, notes: "paper log" });
  assert.equal(entry.start, null);
  assert.equal(entry.end, null);
  assert.equal(entry.durationSeconds, 5_400);
  assert.equal(entry.onTheClock, false);
  assert.throws(() => normalizeTimeEntry(scope, { id: "bad-manual", user_id: "employee-1", jobcode_id: "job-1", type: "manual", start: "2026-09-21T09:00:00-04:00", date: "2026-09-21", duration: 100, last_modified: modified }), /cannot contain start or end/);
});

test("retains provider duration conflicts and maps submitted or approved-through dates", () => {
  const entry = normalizeTimeEntry(scope, { id: "timesheet-invalid", user_id: "employee-1", jobcode_id: "job-1", type: "regular", start: "2026-09-21T09:00:00-04:00", end: "2026-09-21T10:00:00-04:00", date: "2026-09-21", duration: 3_601, tz: -4, tz_str: "America/New_York", last_modified: modified });
  assert.equal(entry.conflict, "invalid_duration");
  const user = normalizeTimeUser(scope, { id: "employee-1", first_name: "Ana", last_name: "Worker", active: true, submitted_to: "2026-09-20", approved_to: "2026-09-19", last_modified: modified });
  assert.equal(user.displayName, "Ana Worker");
  assert.equal(user.submittedTo, "2026-09-20");
  assert.equal(user.approvedTo, "2026-09-19");
  const jobcode = normalizeTimeJobcode(scope, { id: "job-1", name: "Turnover", type: "jobcode", billable: true, active: true, last_modified: modified });
  assert.equal(jobcode.name, "Turnover");
});

test("normalizes deletion objects as source tombstones", () => {
  const deleted = normalizeTimeDeleted(scope, { id: "timesheet-deleted", last_modified: modified, reason: "removed" });
  assert.equal(deleted.providerTimesheetId, "timesheet-deleted");
  assert.equal(deleted.lastModified, modified);
  assert.equal(deleted.providerBody.reason, "removed");
  assert.match(deleted.bodyHash, /^[a-f0-9]{64}$/);
});
