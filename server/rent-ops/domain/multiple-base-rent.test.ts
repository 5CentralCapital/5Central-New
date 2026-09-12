import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveRentRoll, deriveTenantProfile } from "./reports";

function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const tenancy = snapshot.tenancies[0];
  snapshot.tenancies = [{ ...tenancy, status: "current", statusKnowledge: "manual", actualMoveInOn: "2025-01-01", actualMoveInKnowledge: "manual", actualMoveOutOn: undefined }];
  const original = snapshot.recurringSchedules.find(row => row.tenancyId === tenancy.id && row.category === "base_rent")!;
  const first = { ...original, amountCents: 100000, billingFrequency: "monthly" as const };
  const second = { ...original, id: "additional-base", lineageRootId: "additional-base", chargeDefinitionId: "additional-base-definition", chargeDefinitionKey: "additional_base", amountCents: 20000, billingFrequency: "monthly" as const };
  snapshot.chargeDefinitions.push({ ...snapshot.chargeDefinitions.find(row => row.id === original.chargeDefinitionId)!, id: second.chargeDefinitionId, displayName: "Additional base obligation" });
  snapshot.recurringSchedules = [first, second];
  return { snapshot, tenancy: snapshot.tenancies[0], first, second };
}
const filters = { asOfDate: "2026-09-12" };

test("rent roll sums all selected monthly base definitions consistently with profile, excluding superseded history", () => {
  const { snapshot, tenancy, first, second } = fixture();
  const replacement = { ...first, id: "revised-first-base", supersedesId: first.id, versionAction: "replace" as const, recordRevision: 2, effectiveFrom: "2026-09-01", amountCents: 110000 };
  snapshot.recurringSchedules.push(replacement);
  const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)!;
  assert.equal(profile.operationalSchedulesComplete, true);
  assert.deepEqual(new Set(profile.operationalScheduleIds), new Set([replacement.id, second.id]));
  const profileBase = profile.schedules.filter(row => profile.operationalScheduleIds?.includes(row.id) && row.category === "base_rent").reduce((sum, row) => sum + row.amountCents!, 0);
  const roll = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
  assert.equal(profileBase, 130000); assert.equal(roll.baseRentCents, profileBase); assert.equal(roll.totalScheduledCents, profileBase);
});

test("any unresolved selected base amount or cadence prevents a partial rent roll total", () => {
  for (const patch of [{ amountCents: null }, { amountKnowledge: "unknown" }, { billingFrequency: null }]) {
    const { snapshot, tenancy, second } = fixture();
    Object.assign(second, patch);
    const roll = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
    assert.equal(roll.baseRentCents, undefined); assert.equal(roll.totalScheduledCents, null);
    assert.ok(roll.exceptionCodes.includes("base_rent_unconfirmed"));
    assert.equal(deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)?.operationalSchedulesComplete, false);
  }
});

test("missing base schedules remain unresolved", () => {
  const { snapshot, tenancy } = fixture(); snapshot.recurringSchedules = [];
  const roll = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
  assert.equal(roll.baseRentCents, undefined); assert.equal(roll.totalScheduledCents, null);
  assert.equal(deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)?.operationalSchedulesComplete, false);
});

test("explicit trusted zero base amount remains distinct from missing schedules", () => {
  const { snapshot, tenancy, first, second } = fixture();
  first.amountCents = 0; second.amountCents = 0;
  const roll = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
  assert.equal(roll.baseRentCents, 0); assert.equal(roll.totalScheduledCents, 0);
  const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)!;
  assert.equal(profile.operationalSchedulesComplete, true);
  assert.equal(profile.operationalScheduleIds?.length, 2);
});
