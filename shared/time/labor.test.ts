import assert from "node:assert/strict";
import test from "node:test";
import { timeEntrySchema } from "./contracts";
import { allocatePayrollToTimesheets, timeEntryDurationSeconds } from "./labor";

test("overnight shifts count elapsed time across midnight", () => {
  assert.equal(timeEntryDurationSeconds("2026-09-22T22:00:00-04:00", "2026-09-23T06:30:00-04:00"), 8.5 * 3_600);
});

test("daylight-saving transitions use the real elapsed time", () => {
  // Spring forward (US Eastern, 2026-03-08): 01:00 EST to 05:00 EDT is three hours.
  assert.equal(timeEntryDurationSeconds("2026-03-08T01:00:00-05:00", "2026-03-08T05:00:00-04:00"), 3 * 3_600);
  // Fall back (2026-11-01): 00:30 EDT to 02:30 EST is three hours, not two.
  assert.equal(timeEntryDurationSeconds("2026-11-01T00:30:00-04:00", "2026-11-01T02:30:00-05:00"), 3 * 3_600);
  // An overnight shift spanning the fall-back hour.
  assert.equal(timeEntryDurationSeconds("2026-10-31T22:00:00-04:00", "2026-11-01T06:00:00-05:00"), 9 * 3_600);
  assert.throws(() => timeEntryDurationSeconds("2026-03-08T01:00:00", "2026-03-08T05:00:00"), /explicit offset/);
});

test("the entry contract rejects a duration that ignores the DST shift", () => {
  const base = {
    id: "60000000-0000-4000-8000-000000000001",
    source: { provider: "quickbooks_time", organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "sandbox", providerCompanyId: "qbt-1", objectKind: "timesheet", providerObjectId: "ts-1", sourceVersion: "v1" },
    providerTimesheetId: "ts-1", providerUserId: "u-1", providerJobcodeId: "j-1", type: "regular", start: "2026-03-08T01:00:00-05:00", end: "2026-03-08T05:00:00-04:00", date: "2026-03-08",
    timezoneOffsetMinutes: -300, timezoneName: "America/New_York", onTheClock: false, locked: false, providerActive: true, deletedAt: null, notes: "", lastModified: "2026-03-08T10:00:00.000Z",
    reviewState: "needs_review", conflict: "none", mappingStatus: "mapped", correctionRevision: 0, estimatedLaborCostCents: null, estimatedLaborCurrency: null, postedPayrollCents: null, postedPayrollCurrency: null, updatedAt: "2026-03-08T10:00:00.000Z",
  };
  assert.equal(timeEntrySchema.safeParse({ ...base, durationSeconds: 3 * 3_600 }).success, true);
  assert.equal(timeEntrySchema.safeParse({ ...base, durationSeconds: 4 * 3_600 }).success, false, "wall-clock hours are not elapsed hours");
});

test("posted payroll splits exactly across timesheets", () => {
  const byEstimate = allocatePayrollToTimesheets("100000", [
    { id: "a", estimatedCents: "30000", durationSeconds: 3_600 },
    { id: "b", estimatedCents: "30000", durationSeconds: 3_600 },
    { id: "c", estimatedCents: "30000", durationSeconds: 3_600 },
  ]);
  assert.deepEqual(byEstimate.map((item) => item.amountCents), ["33334", "33333", "33333"]);
  const byHours = allocatePayrollToTimesheets("10001", [
    { id: "a", estimatedCents: null, durationSeconds: 7_200 },
    { id: "b", estimatedCents: "5000", durationSeconds: 3_600 },
  ]);
  assert.deepEqual(byHours.map((item) => item.amountCents), ["6667", "3334"]);
  assert.equal(byHours.reduce((total, item) => total + BigInt(item.amountCents), BigInt(0)), BigInt(10_001));
  assert.throws(() => allocatePayrollToTimesheets("100", [{ id: "a", estimatedCents: null, durationSeconds: 0 }]), /no hours/);
});
