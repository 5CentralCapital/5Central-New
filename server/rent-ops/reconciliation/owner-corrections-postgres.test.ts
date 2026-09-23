import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRentOpsSchema } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { createSyntheticRuntimeExecutor } from "../../company/testing/synthetic-database";
import { bytesHash, buildMaintenanceManifest, snapshotHash, verifyMaintenanceReadback } from "./maintenance";
import { reconcileImportedRecords } from "./operator";
import { buildOwnerCorrectionPlan, loadCorrectionPackage, loadResolutions, runOwnerChargeReversals } from "./owner-corrections";
import { SYNTHETIC_IDS as I, SYNTHETIC_OCCURRED_AT, syntheticOwnerCorrectionSnapshot, writeSyntheticCorrectionPackage } from "./owner-corrections-synthetic";

test("owner corrections apply under the real runtime grants: pack via operator, reversals via the audited service", async () => {
  const db = new PGlite(), root = await mkdtemp(join(tmpdir(), "owner-corrections-pg-"));
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    const runtime = await createSyntheticRuntimeExecutor(db);
    // Seed imported synthetic rows through the configured importer role (readiness probing is a runtime-role concern).
    const asImporter = <T,>(work: (query: RentOpsQueryExecutor["query"]) => Promise<T>) => db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE "rent_ops_staging_importer"');
      return work(((sql: string, values?: unknown[]) => tx.query(sql, values?.map(value => value === undefined ? null : value))) as RentOpsQueryExecutor["query"]);
    });
    const seed = new PostgresRentOpsRepository({ query: ((sql: string, values?: unknown[]) => asImporter(query => query(sql, values))) as RentOpsQueryExecutor["query"], transaction: work => asImporter(query => work({ query })) });
    (seed as unknown as { ready: boolean }).ready = true;
    const synthetic = syntheticOwnerCorrectionSnapshot();
    for (const row of synthetic.properties) await seed.saveProperty(row);
    for (const row of synthetic.units) await seed.saveUnit(row);
    for (const row of synthetic.people) await seed.savePerson(row);
    for (const row of synthetic.tenancies) await seed.saveTenancy(row);
    for (const row of synthetic.ledgerTransactions) await seed.saveLedgerTransaction(row);
    const repository = new PostgresRentOpsRepository(runtime);
    const before = await repository.getSnapshot();
    const baselinePath = join(root, "baseline.json"), baselineBytes = Buffer.from(JSON.stringify(before)); await writeFile(baselinePath, baselineBytes);
    const { directory, resolutionsPath } = await writeSyntheticCorrectionPackage(join(root, "package"));
    const build = buildOwnerCorrectionPlan(await loadCorrectionPackage(directory), before, { occurredAt: SYNTHETIC_OCCURRED_AT, baselineSha256: bytesHash(baselineBytes), resolutions: await loadResolutions(resolutionsPath) });
    assert.equal(build.summary.operations, 4);
    const packPath = join(root, "pack.json"), packBytes = Buffer.from(JSON.stringify(build.pack)); await writeFile(packPath, packBytes);
    const context = { actor: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT, packPath, packSha256: bytesHash(packBytes) };
    const { manifest, archivedSnapshot } = buildMaintenanceManifest(before, build.pack!, build.pack!.phases[0], context);
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
    assert.equal(snapshotHash(await repository.getSnapshot()), snapshotHash(before));
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token, archivedSnapshot });
    const afterPack = await repository.getSnapshot();
    verifyMaintenanceReadback(before, afterPack, manifest, applied);
    assert.equal(afterPack.tenancies.find(row => row.id === I.cancelTenancy)!.status, "cancelled");
    assert.equal(afterPack.tenancies.find(row => row.id === I.futureTenancy)!.unitId, "syn-unit-5");

    const options = { actorSubject: "owner-test", occurredAt: SYNTHETIC_OCCURRED_AT };
    const dry = await runOwnerChargeReversals(repository, build.ledgerPlan!, { ...options, mode: "plan" });
    assert.equal(snapshotHash(await repository.getSnapshot()), snapshotHash(afterPack), "dry run rolls back in PostgreSQL");
    await runOwnerChargeReversals(repository, build.ledgerPlan!, { ...options, mode: "apply", approvedPlanToken: dry.token });
    const after = await repository.getSnapshot();
    const added = after.ledgerTransactions.filter(row => !afterPack.ledgerTransactions.some(old => old.id === row.id));
    assert.deepEqual(added.map(row => row.kind), ["reversal", "reversal"]);
    assert.equal(after.ledgerTransactions.filter(row => row.kind === "payment").length, afterPack.ledgerTransactions.filter(row => row.kind === "payment").length);
    for (const original of afterPack.ledgerTransactions) assert.deepEqual(after.ledgerTransactions.find(row => row.id === original.id), original);
  } finally { await db.close(); await rm(root, { recursive: true }); }
});
