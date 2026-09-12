import assert from "node:assert/strict";
import test from "node:test";
import { createDemoAdminSnapshot } from "../demo";
import { buildRecurringChargeRows, buildTenantEditActions, currentMonthlyTotal, filterRecurringCharges } from "./tenant-model";

function fixture() {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const schedule = { ...tenant.schedules[0], id: "current-rent", active: true, category: "base_rent", billingFrequency: "monthly", amountCents: 150000, effectiveFrom: "2026-01-01", effectiveTo: null, resolvedEffectiveTo: null, lineageState: "valid" as const, canScheduleSuccessor: true };
  return { snapshot, tenant: { ...tenant, schedules: [schedule], operationalScheduleIds: [schedule.id], operationalSchedulesComplete: true }, schedule };
}

test("past tenancy with absent move-out remains history without changing source end", () => {
  const { snapshot, tenant, schedule } = fixture();
  const past = { ...tenant.tenancy!, status: "past", actualMoveOutOn: undefined };
  const profile = { ...tenant, tenancy: past, tenancies: [past], operationalScheduleIds: [] };
  const rows = buildRecurringChargeRows(profile, snapshot);
  assert.equal(rows[0].state, "ended");
  assert.match(rows[0].stateReason!, /Tenancy ended.*unavailable/);
  assert.equal(rows[0].effectiveTo, null);
  assert.equal(schedule.effectiveTo, null);
  assert.equal(filterRecurringCharges(rows, "current").length, 0);
  assert.equal(filterRecurringCharges(rows, "history").length, 1);
  assert.equal(currentMonthlyTotal(rows), 0);
  assert.equal(buildTenantEditActions(profile, snapshot, "charges").length, 0);
});

test("actual move-out overrides current status and unknown tenancy never becomes current", () => {
  const { snapshot, tenant } = fixture();
  for (const tenancy of [{ ...tenant.tenancy!, actualMoveOutOn: "2026-01-01" }, { ...tenant.tenancy!, status: undefined }]) {
    const rows = buildRecurringChargeRows({ ...tenant, tenancy, tenancies: [tenancy] }, snapshot);
    assert.notEqual(rows[0].state, "current");
    assert.equal(currentMonthlyTotal(rows), null);
  }
});

test("transfer retains old rent history and shows exact tenancy and unit identity", () => {
  const { snapshot, tenant, schedule } = fixture();
  const old = { ...tenant.tenancy!, id: "old-tenancy", unitId: "old-unit", status: "past" };
  snapshot.snapshot.units.push({ ...tenant.unit!, id: "old-unit", unitNumber: "Old 7" });
  const rows = buildRecurringChargeRows({ ...tenant, tenancies: [old, tenant.tenancy!], schedules: [{ ...schedule, id: "old-rent", tenancyId: old.id, amountCents: 100000 }, schedule] }, snapshot);
  assert.deepEqual(rows.map(row => row.state), ["ended", "current"]);
  assert.match(rows[0].applicabilityLabel, /Old 7.*old-tenancy/);
  assert.equal(currentMonthlyTotal(rows), 150000);
});

test("server precedence excludes inherited alternatives and HAP from contractual monthly total", () => {
  const { snapshot, tenant, schedule } = fixture();
  const rows = buildRecurringChargeRows({ ...tenant, operationalScheduleIds: [schedule.id, "hap"], schedules: [schedule, { ...schedule, id: "inherited", scopeType: "unit", scopeId: tenant.unit!.id, amountCents: 170000 }, { ...schedule, id: "hap", category: "subsidy", amountCents: 80000 }] }, snapshot);
  assert.equal(rows.find(row => row.id === "inherited")!.state, "ended");
  assert.equal(currentMonthlyTotal(rows), 150000);
});

test("missing selection metadata, missing selected rows, and unknown cadence fail closed", () => {
  const { snapshot, tenant, schedule } = fixture();
  for (const patch of [{ operationalScheduleIds: undefined }, { operationalSchedulesComplete: undefined }, { operationalScheduleIds: ["missing"] }, { schedules: [{ ...schedule, billingFrequency: "unrecognized" }] }]) {
    assert.equal(currentMonthlyTotal(buildRecurringChargeRows({ ...tenant, ...patch }, snapshot)), null);
  }
  assert.equal(currentMonthlyTotal([], false), null);
  assert.equal(currentMonthlyTotal([], true), 0);
});
