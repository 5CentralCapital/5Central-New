import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { createEffectiveScheduleSelector, effectiveSchedules } from "./invariants";
import { deriveDashboardSummary } from "./reports";
import type { RentOpsRecurringChargeSchedule } from "../../../shared/rent-ops-contracts";

function scheduleSelectorCases(): RentOpsRecurringChargeSchedule[][] {
  const source = structuredClone(syntheticRentOpsSnapshot().recurringSchedules);
  const root = {...source[0], effectiveTo: "2027-09-30"};
  const replacement: RentOpsRecurringChargeSchedule = {...root, id: "selector-replace", supersedesId: root.id, versionAction: "replace", effectiveFrom: "2026-11-01", amountCents: 130000};
  const end: RentOpsRecurringChargeSchedule = {...replacement, id: "selector-end", supersedesId: replacement.id, versionAction: "end", effectiveFrom: "2027-01-01", effectiveTo: "2027-01-01", active: false, activeKnowledge: "manual", amountCents: null, amountKnowledge: "unknown"};
  const other = {...root, id: "selector-independent", lineageRootId: "selector-independent", category: "recurring_fee" as const, chargeDefinitionId: "selector-fee", chargeDefinitionKey: "selector-fee"};
  return [source, [root], [root, replacement], [root, replacement, end], [replacement],
    [root, replacement, {...replacement, id: "selector-fork"}],
    [root, other, {...replacement, lineageRootId: other.id}],
    [root, {...root}], [root, {...root, id: "selector-unknown", lineageRootId: undefined, active: null, activeKnowledge: "unknown", effectiveFrom: null, effectiveFromKnowledge: "unknown_open_start"}],
    [root, other, replacement],
    [root, {...root, id: "selector-person", lineageRootId: "selector-person", tenancyId: undefined}],
    [root, {...other, scopeType: "property", scopeId: root.propertyId!}],
    [root, {...other, scopeType: "unit", scopeId: root.unitId!}],
  ];
}

const dates = ["2025-12-31", "2026-08-15", "2026-10-31", "2026-11-01", "2027-01-01", "2027-10-01"];
const scopes = [{}, {personId: "demo-person-1", propertyId: "demo-property-a", unitId: "demo-unit-a-1", allowPersonScopedTenant: true}, {personId: "demo-person-1", propertyId: "demo-property-a", unitId: "demo-unit-a-1", allowPersonScopedTenant: false}, {propertyId: "demo-property-b", unitId: "missing-unit"}];

test("request selector equals uncached selection across complete safe and unsafe lineages, dates and scopes", () => {
  for (const schedules of scheduleSelectorCases()) {
    const before = structuredClone(schedules);
    const select = createEffectiveScheduleSelector(schedules);
    for (const date of dates) for (const scope of scopes) for (const tenancyId of ["demo-tenancy-1", "demo-tenancy-2", ""]) {
      assert.deepEqual(select(tenancyId, date, scope), effectiveSchedules(schedules, tenancyId, date, scope));
    }
    assert.deepEqual(schedules, before);
  }
});

test("new report calls and uncached public selection observe appended successors on the same array", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const root = snapshot.recurringSchedules[0];
  const filters = {asOfDate: "2026-08-15", month: "2026-08"};
  const before = deriveDashboardSummary(snapshot, filters);
  snapshot.recurringSchedules.push({...root, id: "fresh-replacement", supersedesId: root.id, versionAction: "replace", effectiveFrom: "2026-08-01", amountCents: root.amountCents! + 12345});
  const after = deriveDashboardSummary(snapshot, filters);
  assert.equal(after.scheduledRentCents, before.scheduledRentCents + 12345);
  assert.deepEqual(createEffectiveScheduleSelector(snapshot.recurringSchedules)(root.tenancyId!, filters.asOfDate), effectiveSchedules(snapshot.recurringSchedules, root.tenancyId!, filters.asOfDate));
});

test("exact tenancy outranks a later person-only fallback without summing rent", async () => {
  const { projectFinancialSchedules } = await import("./financial-projection");
  const source = structuredClone(syntheticRentOpsSnapshot());
  const current = { ...source.recurringSchedules[0], effectiveFrom: "2026-09-12", amountCents: 125000 };
  const wildcard: RentOpsRecurringChargeSchedule = { ...current, id: "october-person-fallback", lineageRootId: "october-person-fallback", tenancyId: undefined, personId: current.scopeId, effectiveFrom: "2026-10-01", amountCents: 999999, active: null, activeKnowledge: "unknown" };
  source.recurringSchedules = [current, wildcard];
  // Keep this fixture's selected unit occupied for both report months.
  source.tenancies = source.tenancies.filter(row => row.id === current.tenancyId);
  source.leaseTerms = source.leaseTerms.filter(row => row.tenancyId === current.tenancyId);
  const scope = { personId: current.scopeId!, propertyId: current.propertyId!, unitId: current.unitId!, allowPersonScopedTenant: true };
  const select = createEffectiveScheduleSelector(source.recurringSchedules);
  assert.deepEqual(select(current.tenancyId!, "2026-10-01", scope).map(row => row.id), [current.id]);
  const projection = projectFinancialSchedules(source, "2026-10");
  assert.deepEqual(projection.rows.filter(row => row.unitId === current.unitId).map(row => [row.scheduleId, row.amountCents]), [[current.id, 125000]]);
  assert.equal(source.recurringSchedules[1].active, null);
  assert.equal(source.recurringSchedules.length, 2);
});

test("exact tenancy successors remain date-effective and unknown scope cannot win", () => {
  const current = { ...structuredClone(syntheticRentOpsSnapshot().recurringSchedules[0]), effectiveFrom: "2026-09-12" };
  const successor: RentOpsRecurringChargeSchedule = { ...current, id: "november-exact", supersedesId: current.id, versionAction: "replace", effectiveFrom: "2026-11-01", amountCents: 135000 };
  const unknown: RentOpsRecurringChargeSchedule = { ...current, id: "unknown-scope", lineageRootId: "unknown-scope", scopeTypeKnowledge: "unknown", scopeLinkKnowledge: "unknown", effectiveFrom: "2026-10-01", amountCents: 999999 };
  const scope = { personId: current.scopeId!, propertyId: current.propertyId!, unitId: current.unitId!, allowPersonScopedTenant: true };
  const select = createEffectiveScheduleSelector([current, successor, unknown]);
  assert.deepEqual(select(current.tenancyId!, "2026-10-15", scope).map(row => row.id), [current.id]);
  assert.deepEqual(select(current.tenancyId!, "2026-11-01", scope).map(row => row.id), [successor.id]);
});
