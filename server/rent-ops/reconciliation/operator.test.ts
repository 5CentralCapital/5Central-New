import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { reconcileImportedRecords, reconciliationHash, type ReconciliationManifest } from "./operator";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "reconciliation-test-"));
  const path = join(directory, "evidence.json");
  const bytes = '{"verifiedStatus":"past"}';
  await writeFile(path, bytes);
  const snapshot = syntheticRentOpsSnapshot();
  const tenancy = snapshot.tenancies[0];
  tenancy.source = { system: "rent_manager", sourceId: "tenant:test", entityType: "tenancy" };
  const repository = new SyntheticRentOpsRepository(snapshot);
  const manifest: ReconciliationManifest = { id: "test", actorSubject: "operator-test", occurredAt: "2026-09-12T12:00:00Z", operations: [{ kind: "tenancy-status", targetId: tenancy.id, expectedRevision: tenancy.recordRevision ?? 1, beforeSha256: reconciliationHash(tenancy), sourceId: tenancy.source.sourceId, status: "past", evidence: { path, sha256: createHash("sha256").update(bytes).digest("hex"), reference: "tenant:test.Status" } }] };
  return { directory, repository, manifest };
}

test("dry run rolls back and exact approved apply preserves ledger", async () => {
  const { directory, repository, manifest } = await setup();
  try {
    const before = await repository.getSnapshot();
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan" });
    assert.equal(reconciliationHash(await repository.getSnapshot()), reconciliationHash(before));
    await assert.rejects(() => reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: "wrong" }), /token/);
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token });
    assert.equal(applied.ledgerUnchanged, true);
    const after = await repository.getSnapshot();
    assert.equal(after.tenancies[0].status, "past");
    assert.equal(after.tenancies[0].actualMoveOutOn, before.tenancies[0].actualMoveOutOn);
    assert.deepEqual(after.ledgerTransactions, before.ledgerTransactions);
    await assert.rejects(() => reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token }), /Before-state changed/);
  } finally { await rm(directory, { recursive: true }); }
});

test("source identity, before-state and evidence bytes fail closed", async () => {
  const { directory, repository, manifest } = await setup();
  try {
    for (const patch of [{ sourceId: "wrong" }, { beforeSha256: "0".repeat(64) }, { evidence: { ...manifest.operations[0].evidence, sha256: "0".repeat(64) } }]) {
      const changed = structuredClone(manifest);
      Object.assign(changed.operations[0], patch);
      await assert.rejects(() => reconcileImportedRecords(repository, changed, { mode: "plan" }));
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("same-value former status confirms unknown knowledge without inventing dates", async () => {
  const { directory, repository, manifest } = await setup();
  try {
    const snapshot = await repository.getSnapshot();
    const tenancy = { ...snapshot.tenancies[0], status: "past" as const, statusKnowledge: "unknown" as const };
    await repository.saveTenancy(tenancy);
    manifest.operations[0].beforeSha256 = reconciliationHash(tenancy);
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan" });
    await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token });
    const saved = (await repository.getSnapshot()).tenancies[0];
    assert.equal(saved.status, "past");
    assert.equal(saved.statusKnowledge, "manual");
    assert.equal(saved.recordRevision, (tenancy.recordRevision ?? 1) + 1);
    assert.equal(saved.actualMoveOutOn, tenancy.actualMoveOutOn);
  } finally { await rm(directory, { recursive: true }); }
});

test("future source departure restores unknown actual date and retains expected date", async () => {
  const { directory, repository, manifest } = await setup();
  try {
    const snapshot = await repository.getSnapshot();
    const tenancy = { ...snapshot.tenancies[0], actualMoveOutOn: "2026-12-31", actualMoveOutKnowledge: "source" as const };
    await repository.saveTenancy(tenancy);
    const guard = manifest.operations[0];
    manifest.operations = [{ ...guard, kind: "tenancy-future-departure", beforeSha256: reconciliationHash(tenancy), observedOn: "2026-09-07", expectedMoveOutOn: "2026-12-31" }];
    const archivedSnapshot = await repository.getSnapshot();
    archivedSnapshot.people.find(person => person.id === tenancy.primaryPersonId)!.sourceAccountFacts = {
      status: "current", rawStatus: "Current", statusKnowledge: "source", postingStartOn: null, postingEndOn: null,
      postingStartKnowledge: "unknown", postingEndKnowledge: "unknown", observedOn: "2026-09-07", artifactSha256: "a".repeat(64),
    };
    archivedSnapshot.tenancies[0] = { ...tenancy, actualMoveOutOn: undefined, actualMoveOutKnowledge: "unknown", expectedMoveOutOn: "2026-12-31", expectedMoveOutKnowledge: "source" };
    const unboundArchive = structuredClone(archivedSnapshot);
    delete unboundArchive.people.find(person => person.id === tenancy.primaryPersonId)!.sourceAccountFacts;
    await assert.rejects(reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot: unboundArchive }), /source observation/);
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
    await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token, archivedSnapshot });
    const saved = (await repository.getSnapshot()).tenancies[0];
    assert.equal(saved.actualMoveOutOn, null); assert.equal(saved.actualMoveOutKnowledge, "unknown");
    assert.equal(saved.expectedMoveOutOn, "2026-12-31"); assert.equal(saved.expectedMoveOutKnowledge, "source");
    assert.equal(saved.status, tenancy.status);
  } finally { await rm(directory, { recursive: true }); }
});


test("status corrections cannot create schedules against an earlier current-tenancy snapshot",async()=>{
  const {directory,repository,manifest}=await setup();
  try {
    const before=await repository.getSnapshot();
    const status=manifest.operations[0];
    for(const kind of ["schedule-establish","schedule-rebuild"] as const){
      const create=kind === "schedule-establish"
        ? {...status,kind,replacement:{id:"new-schedule"}}
        : {...status,kind,targetId:"original-schedule",targetTenancy:{id:status.targetId,expectedRevision:1,beforeSha256:status.beforeSha256},replacement:{id:"new-schedule",tenancyId:status.targetId}};
      for(const operations of [[status,create],[create,status]]){
        await assert.rejects(reconcileImportedRecords(repository,{...manifest,operations:operations as ReconciliationManifest["operations"]},{mode:"plan"}),/separate verified plans/);
      }
    }
    assert.equal(reconciliationHash(await repository.getSnapshot()),reconciliationHash(before));
  } finally {await rm(directory,{recursive:true});}
});
