import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveOperationalScheduleRegister, deriveRentRoll } from "./reports";

function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const tenancy = snapshot.tenancies[0];
  snapshot.tenancies = [{ ...tenancy, status: "current", statusKnowledge: "manual", actualMoveInOn: "2025-01-01", actualMoveInKnowledge: "manual", actualMoveOutOn: undefined }];
  const original = snapshot.recurringSchedules.find(row => row.tenancyId === tenancy.id && row.category === "base_rent")!;
  const root = { ...original, id: "current-rent", amountCents: 125000, billingFrequency: "monthly" as const, source: undefined, sourceArtifactSha256: undefined, artifactObservationOn: undefined, effectiveFrom: "2026-09-12", effectiveFromKnowledge: "manual" as const, active: true, activeKnowledge: "manual" as const, lineageRootId: "current-rent", lineageRootOrigin: "manual" as const, versionOrigin: "manual" as const, versionAction: "root" as const };
  const successor = { ...root, id: "october-rent", supersedesId: root.id, recordRevision: 2, effectiveFrom: "2026-10-01", amountCents: 137500, versionAction: "replace" as const };
  snapshot.recurringSchedules = [root, successor];
  return { snapshot, tenancy: snapshot.tenancies[0], root, successor };
}
const september = { asOfDate: "2026-09-12" };

test("current resident's verified future replacement appears in Future charges before taking effect", () => {
  const { snapshot, root, successor, tenancy } = fixture();
  const before = deriveOperationalScheduleRegister(snapshot, september);
  assert.deepEqual(before.currentScheduleIds, [root.id]);
  assert.deepEqual(before.futureScheduleIds, [successor.id]);
  assert.deepEqual(before.reviewScheduleIds, []);
  assert.equal(deriveRentRoll(snapshot, september).find(row => row.unitId === tenancy.unitId)?.baseRentCents, 125000);
  const october = { asOfDate: "2026-10-01" };
  const effective = deriveOperationalScheduleRegister(snapshot, october);
  assert.deepEqual(effective.currentScheduleIds, [successor.id]);
  assert.deepEqual(effective.futureScheduleIds, []);
  assert.ok(effective.historicalScheduleIds.includes(root.id));
  assert.equal(deriveRentRoll(snapshot, october).find(row => row.unitId === tenancy.unitId)?.baseRentCents, 137500);
});

test("future register excludes malformed successors and unconfirmed cadence", () => {
  for (const patch of [{ supersedesId: "missing-parent" }, { billingFrequency: null }]) {
    const { snapshot, successor } = fixture();
    Object.assign(successor, patch);
    const register = deriveOperationalScheduleRegister(snapshot, september);
    assert.ok(!register.futureScheduleIds.includes(successor.id));
    assert.ok(register.reviewScheduleIds.includes(successor.id));
  }
});

test("future replacement does not reactivate a former resident or cross a confirmed departure", () => {
  for (const patch of [
    { status: "past" as const, actualMoveOutOn: "2026-09-01", actualMoveOutKnowledge: "manual" as const },
    { actualMoveOutOn: "2026-09-30", actualMoveOutKnowledge: "manual" as const },
    { expectedMoveOutOn: "2026-09-30", expectedMoveOutKnowledge: "manual" as const },
  ]) {
    const { snapshot, tenancy, successor } = fixture();
    Object.assign(tenancy, patch);
    const register = deriveOperationalScheduleRegister(snapshot, september);
    assert.ok(!register.futureScheduleIds.includes(successor.id));
    assert.ok(register.historicalScheduleIds.includes(successor.id) || register.reviewScheduleIds.includes(successor.id));
  }
});
