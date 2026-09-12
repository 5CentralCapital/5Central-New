import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { reconcileImportedRecords, reconciliationHash, type ReconciliationManifest } from "./operator";

test("imported account backfill is revision-guarded, rollback-safe and uses UPDATE under runtime role", async () => {
  const db = new PGlite();
  const directory = await mkdtemp(join(tmpdir(), "account-backfill-"));
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.exec("CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON rent_ops_people TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
    await db.exec("INSERT INTO rent_ops_people(id,first_name,last_name,source_system,source_id) VALUES('source-person','Archived','Resident','rent_manager','tenant:123')");
    await db.exec("RESET ROLE; CREATE ROLE qa_reconcile; GRANT USAGE ON SCHEMA public TO qa_reconcile");
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT,INSERT,UPDATE"} ON ${table} TO qa_reconcile`);
    await db.exec("SET ROLE qa_reconcile");
    let snapshots = 0;
    const adapt = (connection: any): RentOpsQueryExecutor => ({ query: async (sql, values) => { if (sql.includes("FROM rent_ops_people")) snapshots++; return connection.query(sql, values?.map(value => value === undefined ? null : value)); }, transaction: async work => connection.transaction ? connection.transaction((tx: any) => work(adapt(tx))) : work(adapt(connection)) });
    const repository = new PostgresRentOpsRepository(adapt(db));
    const before = await repository.getSnapshot();
    const person = before.people[0];
    const facts = { status: "past" as const, rawStatus: "Former", statusKnowledge: "source" as const, postingStartOn: null, postingEndOn: null, postingStartKnowledge: "unknown" as const, postingEndKnowledge: "unknown" as const, observedOn: "2026-09-07", artifactSha256: "a".repeat(64) };
    const path = join(directory, "archived.json");
    const bytes = JSON.stringify(facts); await writeFile(path, bytes);
    const manifest: ReconciliationManifest = { id: "backfill", actorSubject: "qa", occurredAt: "2026-09-12T12:00:00Z", operations: [{ kind: "account-facts", targetId: person.id, expectedRevision: 1, beforeSha256: reconciliationHash(person), sourceId: "tenant:123", facts, evidence: { path, sha256: createHash("sha256").update(bytes).digest("hex"), reference: "tenant:123.Status" } }] };
    const archivedSnapshot = structuredClone(before); archivedSnapshot.people[0].sourceAccountFacts = facts;
    const plan = await reconcileImportedRecords(repository, manifest, { mode: "plan", archivedSnapshot });
    assert.deepEqual((await repository.getSnapshot()).people, before.people);
    const readCount = snapshots;
    await reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token, archivedSnapshot });
    assert.equal(snapshots - readCount, 2, "only before and final snapshot reads per batch");
    const saved = (await repository.getSnapshot()).people[0];
    assert.deepEqual(saved.sourceAccountFacts, facts); assert.equal(saved.recordRevision, 2); assert.deepEqual(saved.source, person.source); assert.equal(saved.firstName, person.firstName);
    await assert.rejects(() => reconcileImportedRecords(repository, manifest, { mode: "apply", approvedPlanToken: plan.token, archivedSnapshot }), /Before-state/);
    const ledger = await db.query("SELECT COUNT(*) AS count FROM rent_ops_ledger_transactions"); assert.equal(Number(ledger.rows[0].count), 0);
    await db.exec("INSERT INTO rent_ops_properties(id,name,slug) VALUES('p','QA','qa'); INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual'); INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,status_knowledge,actual_move_in_on,actual_move_in_knowledge,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge) VALUES('t','p','u','source-person','current','manual','2026-01-01','manual',NOW(),'manual','manual','manual')");
    const { RentOpsService } = await import("../services/service");
    const service = new RentOpsService(repository);
    await service.createChargeDefinition({ id: "rent", displayName: "Rent", category: "base_rent", active: true }, { actorSubject: "qa", occurredAt: manifest.occurredAt });
    await db.exec("RESET ROLE; GRANT SELECT,INSERT ON rent_ops_recurring_charge_schedules TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
    await db.exec(`INSERT INTO rent_ops_recurring_charge_schedules(id,scope_type,scope_id,scope_type_knowledge,scope_link_knowledge,charge_definition_id,person_id,property_id,unit_id,category,category_knowledge,description,description_knowledge,amount_cents,amount_knowledge,effective_from,effective_from_knowledge,active,active_knowledge,source_confidence,charge_definition_knowledge,charge_definition_link_knowledge,source_artifact_sha256,artifact_observation_on,lineage_root_id,lineage_root_origin,version_origin,version_action,record_revision,source_system,source_id)
      VALUES('old-rent','tenant','source-person','source','exact','rent','source-person','p','u','base_rent','source','Rent','source',100000,'known','2026-01-01','source',NULL,'unknown','confirmed','source','exact',repeat('a',64),'2026-09-07','old-rent','artifact','artifact','root',1,'rent_manager','charge:456')`);
    await db.exec("SET ROLE qa_reconcile");
    const configured = await repository.getSnapshot(); const original = configured.recurringSchedules[0]; const tenancy = configured.tenancies[0];
    const rebuild: ReconciliationManifest = { ...manifest, id: "rebuild", operations: [{ kind: "schedule-rebuild", targetId: original.id, expectedRevision: 1, beforeSha256: reconciliationHash(original), sourceId: "charge:456", evidence: manifest.operations[0].evidence, endId: "end-old", effectiveFrom: "2026-09-12", targetTenancy: { id: tenancy.id, expectedRevision: 1, beforeSha256: reconciliationHash(tenancy) }, replacement: { id: "new-rent", scopeType: "tenant", scopeId: "source-person", personId: "source-person", tenancyId: "t", propertyId: "p", unitId: "u", category: "base_rent", chargeDefinitionId: "rent", description: "Confirmed rent", amountCents: 125000, billingFrequency: "monthly", active: true, effectiveFrom: "2026-09-12", lineageRootId: "new-rent", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" } }] };
    const rebuildPlan = await reconcileImportedRecords(repository, rebuild, { mode: "plan" });
    assert.equal((await repository.getSnapshot()).recurringSchedules.length, 1);
    await reconcileImportedRecords(repository, rebuild, { mode: "apply", approvedPlanToken: rebuildPlan.token });
    const final = await repository.getSnapshot();
    assert.deepEqual(final.recurringSchedules.find(row => row.id === original.id), original);
    assert.equal(final.recurringSchedules.find(row => row.id === "new-rent")?.tenancyId, "t");
    assert.equal(final.recurringSchedules.find(row => row.id === "new-rent")?.activeKnowledge, "manual");
    assert.equal(final.ledgerTransactions.length, 0);
    await service.createChargeDefinition({ id: "fee", displayName: "Water", category: "recurring_fee", active: true }, { actorSubject: "qa", occurredAt: new Date(manifest.occurredAt).toISOString() });
    await db.exec("RESET ROLE; GRANT SELECT,INSERT ON rent_ops_tenancies TO rent_ops_staging_importer; INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u2','p','2','manual'); SET ROLE rent_ops_staging_importer");
    await db.exec("INSERT INTO rent_ops_people(id,first_name,source_system,source_id) VALUES('source-person2','Second','rent_manager','tenant:124'); INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,status_knowledge,actual_move_in_on,actual_move_in_knowledge,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,source_system,source_id) VALUES('t2','p','u2','source-person2','current','source','2026-01-01','source',NOW(),'exact','exact','exact','rent_manager','lease:124')");
    await db.exec(`INSERT INTO rent_ops_recurring_charge_schedules(id,scope_type,scope_id,scope_type_knowledge,scope_link_knowledge,charge_definition_id,person_id,property_id,unit_id,category,category_knowledge,description,description_knowledge,amount_cents,amount_knowledge,effective_from,effective_from_knowledge,active,active_knowledge,source_confidence,charge_definition_knowledge,charge_definition_link_knowledge,source_artifact_sha256,artifact_observation_on,lineage_root_id,lineage_root_origin,version_origin,version_action,record_revision,source_system,source_id)
      VALUES('future-rent','tenant','source-person2','source','exact','rent','source-person2','p','u2','base_rent','source','Rent','source',100000,'known','2026-10-01','source',NULL,'unknown','confirmed','source','exact',repeat('a',64),'2026-09-07','future-rent','artifact','artifact','root',1,'rent_manager','charge:457')`);
    await db.exec("SET ROLE qa_reconcile");
    const establishBefore = await repository.getSnapshot(); const targetTenancy = establishBefore.tenancies.find(row => row.id === "t2")!;
    const establish: ReconciliationManifest = { ...manifest, id: "establish", operations: ["base_rent", "recurring_fee"].map(category => ({ kind: "schedule-establish" as const, targetId: "t2", sourceId: "lease:124", expectedRevision: 1, beforeSha256: reconciliationHash(targetTenancy), evidence: manifest.operations[0].evidence, replacement: { id: `established-${category}`, scopeType: "tenant", scopeId: "source-person2", personId: "source-person2", tenancyId: "t2", propertyId: "p", unitId: "u2", category: category as "base_rent" | "recurring_fee", chargeDefinitionId: category === "base_rent" ? "rent" : "fee", description: "Confirmed obligation", amountCents: category === "base_rent" ? 125000 : 3500, billingFrequency: "monthly", active: true, effectiveFrom: "2026-09-12", lineageRootId: `established-${category}`, lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" } })) };
    const establishPlan = await reconcileImportedRecords(repository, establish, { mode: "plan" });
    assert.deepEqual((await repository.getSnapshot()).recurringSchedules, establishBefore.recurringSchedules);
    await reconcileImportedRecords(repository, establish, { mode: "apply", approvedPlanToken: establishPlan.token });
    const established = await repository.getSnapshot();
    assert.deepEqual(established.recurringSchedules.find(row => row.id === "future-rent"), establishBefore.recurringSchedules.find(row => row.id === "future-rent"));
    assert.equal(established.recurringSchedules.filter(row => row.id.startsWith("established-")).length, 2);
    assert.equal(established.ledgerTransactions.length, 0);
    await db.exec("RESET ROLE; GRANT SELECT,INSERT ON rent_ops_lease_terms TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
    await db.exec("INSERT INTO rent_ops_lease_terms(id,tenancy_id,status,contract_start_on,contract_end_on,created_at,status_knowledge,contract_start_knowledge,contract_end_knowledge,tenancy_link_knowledge,source_system,source_id) VALUES('lease-term','t2','draft','2026-09-01','2026-09-30',NOW(),'source','source','source','exact','rent_manager','lease:552')");
    await db.exec("SET ROLE qa_reconcile");
    const supplementalBefore = await repository.getSnapshot(); const term = supplementalBefore.leaseTerms[0];
    const manualRoot = supplementalBefore.recurringSchedules.find(row => row.id === "established-base_rent")!;
    const manualOperation = { kind: "manual-schedule-replace" as const, targetId: manualRoot.id, expectedRevision: 1, beforeSha256: reconciliationHash(manualRoot), evidence: manifest.operations[0].evidence, successorId: "october-rent", effectiveFrom: "2026-10-01", amountCents: 137500, billingFrequency: "monthly" as const, targetTenancy: { id: targetTenancy.id, sourceId: "lease:124", expectedRevision: 1, beforeSha256: reconciliationHash(targetTenancy) } };
    for (const invalid of [{ ...manualOperation, sourceId: "pretend-import" }, { ...manualOperation, targetTenancy: { ...manualOperation.targetTenancy, sourceId: "lease:wrong" } }]) {
      await assert.rejects(() => reconcileImportedRecords(repository, { ...manifest, id: "invalid", operations: [invalid as any] }, { mode: "plan" }), /source-less|tenancy/);
    }
    const supplemental: ReconciliationManifest = { ...manifest, id: "supplemental", operations: [{ kind: "lease-term-correction", targetId: term.id, expectedRevision: 1, beforeSha256: reconciliationHash(term), sourceId: "lease:552", evidence: manifest.operations[0].evidence, patch: { status: "executed", contractEndOn: "2027-07-31", signedOn: "2026-09-08" } }, manualOperation] };
    const supplementalPlan = await reconcileImportedRecords(repository, supplemental, { mode: "plan" });
    assert.deepEqual((await repository.getSnapshot()).leaseTerms, supplementalBefore.leaseTerms);
    await reconcileImportedRecords(repository, supplemental, { mode: "apply", approvedPlanToken: supplementalPlan.token });
    const supplementalAfter = await repository.getSnapshot();
    assert.deepEqual(supplementalAfter.recurringSchedules.find(row => row.id === manualRoot.id), manualRoot);
    assert.equal(supplementalAfter.recurringSchedules.find(row => row.id === "october-rent")?.amountCents, 137500);
    assert.equal(supplementalAfter.recurringSchedules.find(row => row.id === "october-rent")?.effectiveFrom, "2026-10-01");
    assert.equal(supplementalAfter.leaseTerms[0].contractEndOn, "2027-07-31");
    assert.equal(supplementalAfter.leaseTerms[0].signedOn, "2026-09-08");
    assert.equal(supplementalAfter.leaseTerms[0].status, "executed");
    assert.equal(supplementalAfter.leaseTerms[0].recordRevision, 2);
    assert.deepEqual(supplementalAfter.leaseTerms[0].source, term.source);
    assert.equal(supplementalAfter.ledgerTransactions.length, 0);

    const subsidyOperation = { kind: "subsidy-establish" as const, targetId: targetTenancy.id, sourceId: "lease:124", personSourceId: "tenant:124", expectedRevision: 1, beforeSha256: reconciliationHash(targetTenancy), evidence: manifest.operations[0].evidence, grossRentCents: 110000, contract: { id: "verified-hap", tenancyId: "t2", propertyId: "p", unitId: "u2", agencyName: "Verified Agency", effectiveFrom: "2026-02-01", agencyObligationCents: 90600, tenantObligationCents: 19400, status: "active" as const, statusKnowledge: "manual" as const } };
    const subsidyManifest: ReconciliationManifest = { ...manifest, id: "subsidy", operations: [subsidyOperation] };
    const subsidyBefore = await repository.getSnapshot();
    const subsidyPlan = await reconcileImportedRecords(repository, subsidyManifest, { mode: "plan" });
    assert.deepEqual((await repository.getSnapshot()).subsidyContracts, subsidyBefore.subsidyContracts, "dry run rolls subsidy creation back");
    for (const invalid of [
      { ...subsidyOperation, personSourceId: "tenant:other" },
      { ...subsidyOperation, grossRentCents: 120000 },
      { ...subsidyOperation, expectedRevision: 2 },
      { ...subsidyOperation, contract: { ...subsidyOperation.contract, unitId: "u" } },
      { ...subsidyOperation, contract: { ...subsidyOperation.contract, effectiveFrom: "2026-02-30" } },
      { ...subsidyOperation, contract: { ...subsidyOperation.contract, effectiveTo: "2026-01-01" } },
      { ...subsidyOperation, contract: { ...subsidyOperation.contract, statusKnowledge: "unknown" as const } },
    ]) await assert.rejects(() => reconcileImportedRecords(repository, { ...subsidyManifest, operations: [invalid] }, { mode: "plan" }), /Subsidy establishment|Before-state/);
    await assert.rejects(() => reconcileImportedRecords(repository, subsidyManifest, { mode: "apply", approvedPlanToken: "wrong" }), /Exact approved/);
    // Any intervening contract change invalidates the approved plan, even on another tenancy.
    await service.saveSubsidyContract({ ...subsidyOperation.contract, id: "other-hap", tenancyId: "t", unitId: "u" });
    await assert.rejects(() => reconcileImportedRecords(repository, subsidyManifest, { mode: "apply", approvedPlanToken: subsidyPlan.token }), /Exact approved/);
    const refreshedPlan = await reconcileImportedRecords(repository, subsidyManifest, { mode: "plan" });
    await reconcileImportedRecords(repository, subsidyManifest, { mode: "apply", approvedPlanToken: refreshedPlan.token });
    const subsidyAfter = await repository.getSnapshot();
    assert.equal(subsidyAfter.subsidyContracts.find(row => row.id === "verified-hap")?.agencyObligationCents, 90600);
    assert.equal(subsidyAfter.subsidyContracts.find(row => row.id === "verified-hap")?.tenantObligationCents, 19400);
    assert.deepEqual(subsidyAfter.tenancies, subsidyBefore.tenancies);
    assert.deepEqual(subsidyAfter.recurringSchedules, subsidyBefore.recurringSchedules);
    assert.deepEqual(subsidyAfter.ledgerTransactions, subsidyBefore.ledgerTransactions);
    assert.deepEqual(subsidyAfter.paymentAllocations, subsidyBefore.paymentAllocations);
    await assert.rejects(() => reconcileImportedRecords(repository, { ...subsidyManifest, id: "overlap", operations: [{ ...subsidyOperation, contract: { ...subsidyOperation.contract, id: "duplicate-hap" } }] }, { mode: "plan" }), /overlaps/);

  } finally { await db.close(); await rm(directory, { recursive: true }); }
});
