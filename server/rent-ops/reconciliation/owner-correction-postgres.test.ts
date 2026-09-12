import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "../services/service";
import { buildMaintenanceManifest, bytesHash, verifyMaintenanceReadback, type MaintenancePack } from "./maintenance";
import { reconcileImportedRecords } from "./operator";
import { deriveRentRoll } from "../domain/reports";

test("owner expected departure and same-day manual correction are atomic and preserve original facts", async () => {
  const db = new PGlite(), directory = await mkdtemp(join(tmpdir(), "owner-correction-"));
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.exec("INSERT INTO rent_ops_properties(id,name,slug) VALUES('p','QA','qa'); INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('person','Test','Resident'); INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual'),('u2','p','2','manual'),('u3','p','3','manual'); CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON rent_ops_tenancies TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer; INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,status_knowledge,actual_move_in_on,actual_move_in_knowledge,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,source_system,source_id) VALUES('t','p','u','person','current','source','2026-01-01','source',NOW(),'exact','exact','exact','rent_manager','lease:owner'); RESET ROLE; INSERT INTO rent_ops_tenant_accounts(id,email,person_id,tenancy_id) VALUES('portal-account','resident@example.test','person','t'); CREATE ROLE qa_owner; GRANT USAGE ON SCHEMA public TO qa_owner");
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT,INSERT,UPDATE"} ON ${table} TO qa_owner`);
    await db.exec("GRANT SELECT,UPDATE ON rent_ops_tenant_accounts TO qa_owner; SET ROLE qa_owner");
    const queryOnly = (connection: any): RentOpsQueryExecutor => ({ query: (sql, values) => connection.query(sql, values?.map(value => value === undefined ? null : value)) });
    const repository = new PostgresRentOpsRepository({ ...queryOnly(db), transaction: work => db.transaction(tx => work(queryOnly(tx))) });
    const service = new RentOpsService(repository), occurredAt = "2026-09-12T15:00:00.000Z", context = { actorSubject: "owner-test", occurredAt };
    await service.createChargeDefinition({ id: "rent", displayName: "Rent", category: "base_rent", active: true }, context);
    await service.saveRecurringSchedule({ id: "old-root", scopeType: "tenant", scopeId: "person", personId: "person", tenancyId: "t", propertyId: "p", unitId: "u", chargeDefinitionId: "rent", category: "base_rent", description: "Rent", amountCents: 125000, billingFrequency: "monthly", effectiveFrom: "2026-09-12", active: true, lineageRootId: "old-root", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" }, context);
    await service.saveLeaseTerm({ id: "current-lease", tenancyId: "t", status: null, statusKnowledge: "unknown", monthToMonth: null, monthToMonthKnowledge: "unknown", contractStartOn: "2026-02-01", contractEndOn: "2027-01-31", createdAt: occurredAt } as any);
    const before = await repository.getSnapshot();
    const pack: MaintenancePack = { version: 1, initialBaselineSha256: "a".repeat(64), counts: {}, provenance: "owner instruction", phases: [{ id: "owner-update", operations: [
      { target: { collection: "tenancies", id: "t" }, values: { kind: "tenancy-expected-departure", expectedMoveOutOn: "2026-09-30" }, reference: "Owner confirmed departure" },
      { target: { collection: "recurringSchedules", id: "old-root" }, values: { kind: "manual-schedule-correct", endId: "old-end", replacementId: "new-root", effectiveFrom: "2026-09-12", amountCents: 137500, billingFrequency: "monthly", targetTenancy: { $guard: { collection: "tenancies", id: "t" } } }, reference: "Owner confirmed current rent" },
    ] }] };
    const path = join(directory, "pack.json"), bytes = Buffer.from(JSON.stringify(pack)); await writeFile(path, bytes);
    const { manifest } = buildMaintenanceManifest(before, pack, pack.phases[0], { actor: "owner-test", occurredAt, packPath: path, packSha256: bytesHash(bytes) });
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan" });
    assert.deepEqual(await repository.getSnapshot(), before);
    const lateEvening = structuredClone(manifest); lateEvening.occurredAt = "2026-09-13T02:00:00.000Z";
    await reconcileImportedRecords(repository, lateEvening, { mode: "plan" });
    assert.deepEqual(await repository.getSnapshot(), before, "September 12 business-day correction remains valid after UTC midnight");
    for (const patch of [{ expectedMoveOutOn: "2026-09-11" }, { expectedMoveOutOn: "2026-02-30" }]) {
      const invalid = structuredClone(manifest); Object.assign(invalid.operations[0], patch);
      await assert.rejects(reconcileImportedRecords(repository, invalid, { mode: "plan" }), /prospective date/);
    }
    const invalidRoot = structuredClone(manifest); Object.assign(invalidRoot.operations[1], { effectiveFrom: "2026-09-13" });
    await assert.rejects(reconcileImportedRecords(repository, invalidRoot, { mode: "plan" }), /exact existing start/);
    assert.deepEqual(await repository.getSnapshot(), before, "failed later operation rolls earlier departure patch back");
    const applied = await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token });
    const after = await repository.getSnapshot(); verifyMaintenanceReadback(before, after, manifest, applied);
    assert.equal(after.tenancies[0].expectedMoveOutOn, "2026-09-30"); assert.equal(after.tenancies[0].expectedMoveOutKnowledge, "manual");
    assert.equal(after.tenancies[0].status, before.tenancies[0].status); assert.equal(after.tenancies[0].actualMoveOutOn, before.tenancies[0].actualMoveOutOn);
    assert.deepEqual(after.recurringSchedules.find(row => row.id === "old-root"), before.recurringSchedules[0]);
    assert.equal(after.recurringSchedules.find(row => row.id === "old-end")?.versionAction, "end");
    assert.equal(after.recurringSchedules.find(row => row.id === "new-root")?.amountCents, 137500);
    const missing = structuredClone(after); missing.recurringSchedules = missing.recurringSchedules.filter(row => row.id !== "new-root");
    assert.throws(() => verifyMaintenanceReadback(before, missing, manifest, applied), /readback_record_missing/);
    const tampered = structuredClone(after); tampered.recurringSchedules.find(row => row.id === "old-root")!.amountCents = 137500;
    assert.throws(() => verifyMaintenanceReadback(before, tampered, manifest, applied), /unrelated_record_changed/);
    assert.equal(deriveRentRoll(after, { asOfDate: "2026-09-12" })[0].baseRentCents, 137500);
    assert.deepEqual(after.ledgerTransactions, before.ledgerTransactions); assert.deepEqual(after.paymentAllocations, before.paymentAllocations);
    const transferPack: MaintenancePack = { ...pack, phases: [{ id: "owner-transfer", operations: [{ target: { collection: "tenancies", id: "t" }, reference: "Owner confirmed present unit", values: {
      kind: "tenancy-transfer", effectiveOn: "2026-09-12", newTenancyId: "transferred-t", leaseTransfers: [{ guard: { $guard: { collection: "leaseTerms", id: "current-lease" } }, newId: "transferred-lease" }], membershipTransfers: [], destinationUnit: { $guard: { collection: "units", id: "u2" } },
      scheduleTransfers: [{ guard: { $guard: { collection: "recurringSchedules", id: "new-root" } }, endId: "transfer-end", replacementId: "transferred-rent" }],
    } }] }] };
    const transferBytes = Buffer.from(JSON.stringify(transferPack)); await writeFile(path, transferBytes);
    const transfer = buildMaintenanceManifest(after, transferPack, transferPack.phases[0], { actor: "owner-test", occurredAt, packPath: path, packSha256: bytesHash(transferBytes) }).manifest;
    const transferPlan = await reconcileImportedRecords(repository, transfer, { mode: "plan" });
    assert.deepEqual(await repository.getSnapshot(), after);
    const transferredPlan = await reconcileImportedRecords(repository, transfer, { mode: "apply", approvedPlanToken: transferPlan.token });
    const transferred = await repository.getSnapshot(); verifyMaintenanceReadback(after, transferred, transfer, transferredPlan);
    const oldTenancy = transferred.tenancies.find(row => row.id === "t")!, newTenancy = transferred.tenancies.find(row => row.id === "transferred-t")!;
    assert.equal(oldTenancy.unitId, "u"); assert.equal(oldTenancy.actualMoveOutOn, undefined); assert.equal(oldTenancy.operationalEndConfirmedOn, "2026-09-12");
    assert.equal(newTenancy.unitId, "u2"); assert.equal(newTenancy.actualMoveInOn, undefined); assert.equal(newTenancy.occupancyConfirmedOn, "2026-09-12");
    assert.equal(deriveRentRoll(transferred, { asOfDate: "2026-09-12" }).find(row => row.unitId === "u2")?.baseRentCents, 137500);
    assert.equal(deriveRentRoll(transferred, { asOfDate: "2026-09-11" }).find(row => row.unitId === "u")?.occupancy, "current");
    assert.deepEqual(transferred.recurringSchedules.find(row => row.id === "new-root"), after.recurringSchedules.find(row => row.id === "new-root"));
    assert.deepEqual(transferred.ledgerTransactions, after.ledgerTransactions); assert.deepEqual(transferred.paymentAllocations, after.paymentAllocations);
    const copiedLease = transferred.leaseTerms.find(row => row.id === "transferred-lease")!;
    assert.equal(copiedLease.contractStartOn, "2026-02-01"); assert.equal(copiedLease.contractEndOn, "2027-01-31");
    assert.equal(copiedLease.statusKnowledge, "unknown"); assert.equal(copiedLease.signedOn, undefined);
    assert.deepEqual(transferred.leaseTerms.find(row => row.id === "current-lease"), after.leaseTerms.find(row => row.id === "current-lease"));
    const account = (await repository.readPortalAccountBindings!("person"))[0];
    assert.equal(account.tenancyId, "transferred-t"); assert.equal(account.status, "pending"); assert.equal(account.sessionVersion, 2);


  } finally { await db.close(); await rm(directory, { recursive: true }); }
});
