import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { readPack, bytesHash, buildMaintenanceManifest, resolveValue, verifyMaintenanceReadback, type MaintenancePack } from "./maintenance";
import { reconcileImportedRecords, reconciliationHash } from "./operator";
function setup() {
  const snapshot = syntheticRentOpsSnapshot();
  snapshot.tenancies[0].source = { system: "rent_manager", entityType: "tenancy", sourceId: "example-source" };
  const pack: MaintenancePack = { version: 1, initialBaselineSha256: "a".repeat(64), counts: { tenancies: snapshot.tenancies.length }, provenance: { role: "test" }, phases: [{ id: "reviewed", operations: [{ target: { collection: "tenancies", sourceId: "example-source" }, expected: { status: snapshot.tenancies[0].status }, values: { kind: "tenancy-status", status: "past" }, reference: "Reviewed example source" }] }] };
  return { snapshot, pack };
}
test("pack bytes, ambiguous identity, guard override and references fail closed", () => {
  const { snapshot, pack } = setup(), bytes = Buffer.from(JSON.stringify(pack)), digest = bytesHash(bytes);
  assert.deepEqual(readPack(bytes, digest), pack);
  assert.throws(() => readPack(Buffer.concat([bytes, Buffer.from(" ")]), digest), /pack_hash/);
  const context = { actor: "test-operator", occurredAt: "2025-01-01T00:00:00Z", packPath: "unused", packSha256: digest };
  const built = buildMaintenanceManifest(snapshot, pack, pack.phases[0], context);
  assert.equal(built.manifest.operations[0].targetId, snapshot.tenancies[0].id);
  assert.equal(built.manifest.operations[0].beforeSha256, reconciliationHash(snapshot.tenancies[0]));
  const changed = structuredClone(pack); changed.phases[0].operations[0].values.targetId = "override";
  assert.throws(() => buildMaintenanceManifest(snapshot, changed, changed.phases[0], context), /guard_override/);
  const duplicate = structuredClone(snapshot); duplicate.tenancies.push({ ...snapshot.tenancies[0], id: "duplicate" });
  assert.throws(() => resolveValue(duplicate, { $ref: { collection: "tenancies", sourceId: "example-source" }, field: "id" }), /identity_not_unique/);
  assert.throws(() => resolveValue(snapshot, { $ref: { collection: "tenancies", sourceId: "example-source" }, field: "source.sourceId" }), /invalid_reference/);
  const wrong = structuredClone(pack); wrong.phases[0].operations[0].expected = { status: "cancelled" };
  assert.throws(() => buildMaintenanceManifest(snapshot, wrong, wrong.phases[0], context), /expected_value_changed/);
});
test("resolved plan rolls back, exact application reads back, unrelated edits are rejected", async () => {
  const { snapshot, pack } = setup(), directory = await mkdtemp(join(tmpdir(), "maintenance-test-"));
  try {
    const path = join(directory, "private.json"), bytes = Buffer.from(JSON.stringify(pack)); await writeFile(path, bytes);
    const { manifest, archivedSnapshot } = buildMaintenanceManifest(snapshot, pack, pack.phases[0], { actor: "test-operator", occurredAt: "2025-01-01T00:00:00Z", packPath: path, packSha256: bytesHash(bytes) });
    const repository = new SyntheticRentOpsRepository(snapshot), before = await repository.getSnapshot();
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
    assert.deepEqual(await repository.getSnapshot(), before);
    await assert.rejects(() => reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: "wrong", archivedSnapshot }), /token/);
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token, archivedSnapshot });
    const after = await repository.getSnapshot(); verifyMaintenanceReadback(before, after, manifest, applied);
    const tampered = structuredClone(after); tampered.people[0].displayName += " changed";
    assert.throws(() => verifyMaintenanceReadback(before, tampered, manifest, applied), /unrelated_record_changed/);
  } finally { await rm(directory, { recursive: true }); }
});

test("literal data references cannot read prototypes or silently skip required groups", () => {
  const { snapshot, pack } = setup();
  assert.deepEqual(resolveValue(snapshot, { $data: ["facts", "sample"] }, { facts: { sample: { status: "current" } } }), { status: "current" });
  assert.throws(() => resolveValue(snapshot, { $data: ["__proto__"] }, {}), /invalid_data_reference/);
  assert.throws(() => resolveValue(snapshot, { $data: ["missing"] }, {}), /data_reference_missing/);
  pack.phases[0].checkGroups = ["required"];
  assert.throws(() => buildMaintenanceManifest(snapshot, pack, pack.phases[0], { actor: "test-operator", occurredAt: "2025-01-01T00:00:00Z", packPath: "unused", packSha256: "a".repeat(64) }), /check_group_missing/);
});

test("schedule-end pack appends a verified end marker and preserves imported history and ledger", async () => {
  const { snapshot, pack } = setup(), directory = await mkdtemp(join(tmpdir(), "maintenance-end-test-"));
  try {
    const original = snapshot.recurringSchedules[0];
    Object.assign(original, { source: { system: "rent_manager", entityType: "recurring_charge_schedule", sourceId: "reviewed-fee" }, lineageRootOrigin: "artifact", versionOrigin: "artifact", sourceArtifactSha256: "b".repeat(64), artifactObservationOn: "2026-09-07" });
    pack.phases[0].operations = [{ target: { collection: "recurringSchedules", sourceId: "reviewed-fee" }, expected: { amountCents: original.amountCents }, values: { kind: "schedule-end", successorId: "reviewed-fee-end", effectiveFrom: "2026-09-12" }, reference: "Reviewed excluded fee" }];
    const path = join(directory, "pack.json"), bytes = Buffer.from(JSON.stringify(pack)); await writeFile(path, bytes);
    const context = { actor: "test-operator", occurredAt: "2026-09-12T00:00:00Z", packPath: path, packSha256: bytesHash(bytes) };
    const { manifest } = buildMaintenanceManifest(snapshot, pack, pack.phases[0], context);
    const wrongCollection = structuredClone(pack); wrongCollection.phases[0].operations[0].target = { collection: "tenancies", sourceId: "example-source" }; delete wrongCollection.phases[0].operations[0].expected;
    assert.throws(() => buildMaintenanceManifest(snapshot, wrongCollection, wrongCollection.phases[0], context), /operation_collection_mismatch/);
    const repository = new SyntheticRentOpsRepository(snapshot), before = await repository.getSnapshot();
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan" });
    assert.deepEqual(await repository.getSnapshot(), before);
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token });
    const after = await repository.getSnapshot();
    verifyMaintenanceReadback(before, after, manifest, applied);
    assert.deepEqual(after.recurringSchedules.find(row => row.id === original.id), original);
    const ended = after.recurringSchedules.find(row => row.id === "reviewed-fee-end")!;
    assert.equal(ended.supersedesId, original.id); assert.equal(ended.versionAction, "end"); assert.equal(ended.active, false);
    assert.deepEqual(after.ledgerTransactions, before.ledgerTransactions); assert.deepEqual(after.paymentAllocations, before.paymentAllocations);
    const missing = structuredClone(after); missing.recurringSchedules = missing.recurringSchedules.filter(row => row.id !== ended.id);
    assert.throws(() => verifyMaintenanceReadback(before, missing, manifest, applied), /readback_record_missing/);
    const changed = structuredClone(after); changed.recurringSchedules.find(row => row.id === original.id)!.active = false;
    assert.throws(() => verifyMaintenanceReadback(before, changed, manifest, applied), /unrelated_record_changed/);
    const ledger = structuredClone(after); ledger.ledgerTransactions[0].amountCents += 100;
    assert.throws(() => verifyMaintenanceReadback(before, ledger, manifest, applied), /unrelated_record_changed|ledger_changed/);
  } finally { await rm(directory, { recursive: true }); }
});

test("indexed readback retains collection guards and rejects duplicate IDs", () => {
  const { snapshot } = setup();
  const manifest = { id: "readback", actorSubject: "test", occurredAt: "2025-01-01T00:00:00Z", operations: [] };
  const plan = { token: "test", manifestHash: "test", changes: [], ledgerUnchanged: true as const };
  verifyMaintenanceReadback(snapshot, structuredClone(snapshot), manifest, plan);
  const reordered = structuredClone(snapshot); reordered.people.reverse();
  verifyMaintenanceReadback(snapshot, reordered, manifest, plan);
  const duplicate = structuredClone(snapshot); duplicate.people.push({ ...duplicate.people[0] });
  assert.throws(() => verifyMaintenanceReadback(snapshot, duplicate, manifest, plan), /duplicate_record_id/);
  assert.throws(() => verifyMaintenanceReadback(duplicate, snapshot, manifest, plan), /duplicate_record_id/);
  const missing = structuredClone(snapshot); missing.people.pop();
  assert.throws(() => verifyMaintenanceReadback(snapshot, missing, manifest, plan), /unrelated_record_changed/);
  const added = structuredClone(snapshot); added.people.push({ ...added.people[0], id: "unexpected" });
  assert.throws(() => verifyMaintenanceReadback(snapshot, added, manifest, plan), /unexpected_record_created/);
  const activity = structuredClone(snapshot); activity.activityEvents.push({ id: "operator-event", type: "system", occurredAt: "2025-01-01T00:00:00Z", actor: "admin", summary: "Reviewed correction" });
  verifyMaintenanceReadback(snapshot, activity, manifest, plan);
  activity.activityEvents.push({ ...activity.activityEvents[activity.activityEvents.length - 1] });
  assert.throws(() => verifyMaintenanceReadback(snapshot, activity, manifest, plan), /duplicate_record_id/);
});
