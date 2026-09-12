import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import type { RentOpsRecurringChargeSchedule } from "../../../shared/rent-ops-contracts";
import { serializeAdminRecurringSchedules, serializeAdminSnapshot, serializeAdminTenantProfile } from "./entities";
import { serializeWorkspaceCollectionItems } from "./workspace-read";
import { RentOpsService } from "../services/service";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";

function chain() {
  const root = {...structuredClone(syntheticRentOpsSnapshot().recurringSchedules[0]), effectiveTo: "2027-09-30", amountCents: 125000};
  const replacement: RentOpsRecurringChargeSchedule = {...root, id: "synthetic-replacement", supersedesId: root.id, versionAction: "replace", effectiveFrom: "2026-11-01", amountCents: 130000};
  const end: RentOpsRecurringChargeSchedule = {...replacement, id: "synthetic-end", supersedesId: replacement.id, versionAction: "end", effectiveFrom: "2027-01-01", effectiveTo: "2027-01-01", active: false, activeKnowledge: "manual", amountCents: null, amountKnowledge: "unknown"};
  return {root, replacement, end};
}

test("recurring batch resolves root/replace/end boundaries without exposing lineage or changing source ranges", () => {
  const {root, replacement, end} = chain();
  const rows = [root, replacement, end];
  const before = structuredClone(rows);
  const result = serializeAdminRecurringSchedules(rows);
  assert.deepEqual(result.map(row => [row.resolvedEffectiveTo, row.lineageState, row.canScheduleSuccessor]), [
    ["2026-10-31", "valid", false], ["2026-12-31", "valid", false], ["2027-01-01", "valid", false],
  ]);
  assert.equal(result[0].effectiveTo, "2027-09-30");
  assert.deepEqual(rows, before);
  assert.doesNotMatch(JSON.stringify(result), /lineageRoot|supersedesId|versionAction|versionOrigin|sourceArtifact|artifactObservation/);
  const latest = serializeAdminRecurringSchedules([root, replacement]);
  assert.equal(latest[1].canScheduleSuccessor, true);
  assert.equal(serializeAdminRecurringSchedules([{...root, effectiveTo: undefined}])[0].resolvedEffectiveTo, null);
});

test("unsafe fork, orphan, cross-chain, duplicate and end successors remain unknown and disabled", () => {
  const {root, replacement, end} = chain();
  const otherRoot = {...root, id: "other-root", lineageRootId: "other-root"};
  const cases = [
    [replacement],
    [root, replacement, {...replacement, id: "fork"}],
    [root, otherRoot, {...replacement, lineageRootId: otherRoot.id}],
    [root, {...root}],
    [root, replacement, end, {...replacement, id: "after-end", supersedesId: end.id, effectiveFrom: "2027-02-01"}],
  ];
  for (const rows of cases) {
    assert.ok(serializeAdminRecurringSchedules(rows).every(row => row.lineageState === "unknown" && row.canScheduleSuccessor === false && row.resolvedEffectiveTo === null));
  }
});

test("derived metadata cannot be supplied by an unverified source row", () => {
  const {root} = chain();
  const unresolved = {...root, lineageRootId: undefined, lineageState: "valid", resolvedEffectiveTo: "2026-01-01", canScheduleSuccessor: true};
  const [view] = serializeAdminRecurringSchedules([unresolved]);
  assert.equal(view.lineageState, "unknown");
  assert.equal(view.resolvedEffectiveTo, null);
  assert.equal(view.canScheduleSuccessor, false);
});

test("snapshot, single-table workspace collection and scoped tenant use complete lineage", async () => {
  const {root, replacement} = chain();
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.recurringSchedules = [root, replacement];
  const expected = serializeAdminRecurringSchedules(snapshot.recurringSchedules);
  assert.deepEqual(serializeAdminSnapshot(snapshot).recurringSchedules, expected);
  assert.deepEqual(serializeWorkspaceCollectionItems(snapshot.recurringSchedules, "recurringSchedules").items, expected);
  const onlyReplacement = serializeAdminTenantProfile({schedules: [replacement]}, snapshot.recurringSchedules);
  assert.deepEqual(onlyReplacement.schedules, [expected[1]]);
  const repository = new SyntheticRentOpsRepository(snapshot);
  let reads = 0;
  Object.assign(repository, {getOperationalSnapshot: async () => {reads++; return snapshot;}, getSnapshot: async () => {throw new Error("Must use operational read");}});
  const service = new RentOpsService(repository);
  const context = await service.tenantProfileContext(root.scopeId!, {asOfDate: "2026-08-15"});
  assert.equal(reads, 1);
  assert.ok(context.profile);
  assert.equal(serializeAdminTenantProfile(context.profile, context.completeSchedules).schedules[0].resolvedEffectiveTo, "2026-10-31");
});
