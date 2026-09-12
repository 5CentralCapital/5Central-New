import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { performance } from "node:perf_hooks";
import { createRentOpsPoolExecutor, type RentOpsRuntimePool } from "../runtime-database";
import { createPostgresRentOpsRepository, type RentOpsQueryExecutor } from "./postgres";
import { buildRentOpsTableBatchSql, decodeRentOpsTableBatch, RENT_OPS_BATCH_TABLES } from "./read-table-batch";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { serializeWorkspaceBootstrap } from "../presentation/workspace-read";
import { serializeAdminSnapshot } from "../presentation/entities";

test("batch SQL rejects unknown, duplicate, empty and unsafe identifiers before querying", async () => {
  let queries = 0;
  const pool: RentOpsRuntimePool = {query: async () => {queries++; return {rows: []};}, connect: async () => {throw new Error("Unexpected transaction");}};
  const executor = createRentOpsPoolExecutor(pool);
  for (const tables of [[], ["rent_ops_properties", "rent_ops_properties"], ["rent_ops_source_payloads"], ["rent_ops_people; DROP TABLE rent_ops_people"], ["rent_ops_application_answer_occurrences"]]) {
    assert.throws(() => buildRentOpsTableBatchSql(tables), /Invalid Rent Operations table batch/);
    await assert.rejects(executor.readTableBatch!(tables), /Invalid Rent Operations table batch/);
  }
  assert.equal(queries, 0);
  assert.throws(() => decodeRentOpsTableBatch({}, ["rent_ops_people"]), /Invalid Rent Operations table batch result/);
  assert.throws(() => decodeRentOpsTableBatch({rent_ops_people: [null]}, ["rent_ops_people"]), /Invalid Rent Operations table batch row/);
  assert.deepEqual(decodeRentOpsTableBatch({rent_ops_people: '[{"id":"one","archived":false,"phone_methods":[]}]'}, ["rent_ops_people"]), {rent_ops_people: [{id:"one",archived:false,phone_methods:[]}]});
});

test("PGlite batch preserves legacy mapped rows, dates, nulls, JSON and financial inputs with one statement", async () => {
  const db = new PGlite();
  const calls: string[] = [];
  try {
    await ensureRentOpsSchema({apply: true, executor: async sql => {await db.exec(sql);}});
    await db.exec(`
      INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type) VALUES('p','QA','qa','1 QA Way','QA','FL','00000','multifamily');
      INSERT INTO rent_ops_units(id,property_id,unit_number,bedrooms,bathrooms,amenities,property_link_knowledge) VALUES('u','p','1',2,1.5,'["pool","lift"]','manual');
      INSERT INTO rent_ops_people(id,first_name,last_name,archived,phone_methods) VALUES('person','QA','Resident',false,'[]');
      INSERT INTO rent_ops_people(id,first_name,last_name,archived) VALUES('z-contact','Last','Contact',true),('a-contact','First','Contact',false);
      INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,actual_move_in_on,created_at,ended_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES('t','p','u','person','current','2026-01-01','2026-01-01 01:30:00.123456-05',NULL,'manual','manual','manual','manual');
      INSERT INTO rent_ops_lease_terms(id,tenancy_id,status,contract_start_on,contract_end_on,month_to_month,created_at) VALUES('lease','t','executed','2026-01-01',NULL,true,'2026-01-01 08:00:00+02');
      INSERT INTO rent_ops_applications(id,source_type,status,email,first_name,last_name,property_id,profile_answers,employment,created_at) VALUES('app','manual','draft','qa@example.test','QA','Applicant','p','{"nested":{"created_at":"leave-this-string","large":9007199254740991},"arr":[null,true,1.25]}','{"employed":false}', '2026-01-01 01:00:00-05');
      INSERT INTO rent_ops_activity_events(id,property_id,unit_id,person_id,tenancy_id,type,occurred_at,actor,summary,detail,metadata) VALUES('event','p','u','person','t','note','2026-08-15 12:34:56.987654+05:30','QA','Note',NULL,'{"source":"test","nested":[true,null]}');
      INSERT INTO rent_ops_ledger_transactions(id,property_id,unit_id,tenancy_id,person_id,kind,category,status,amount_cents,posted_on,description,payer,amount_knowledge,category_knowledge,status_knowledge,posted_on_knowledge,description_knowledge,payer_knowledge,charge_definition_link_knowledge,property_link_knowledge,unit_link_knowledge,person_link_knowledge,tenancy_link_knowledge,due_on_knowledge,payment_method_knowledge) VALUES('charge','p','u','t','person','charge','base_rent','posted',2147483647,'2026-08-01','Rent','tenant','known','manual','manual','manual','manual','manual','unknown','manual','manual','manual','manual','unknown','unknown');
      CREATE ROLE rent_ops_staging_importer; GRANT USAGE ON SCHEMA public TO rent_ops_staging_importer; GRANT SELECT,INSERT ON rent_ops_security_deposits TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer;
      INSERT INTO rent_ops_security_deposits(id,property_id,unit_id,tenancy_id,person_id,type,amount_held_cents,source_balance_cents,source_system,source_id,received_on_knowledge,unit_link_knowledge) VALUES('deposit','p','u','t','person','security',NULL,-500,'rent_manager','source-deposit','unknown','exact');
      RESET ROLE; CREATE ROLE batch_read_runtime;
      GRANT USAGE ON SCHEMA public TO batch_read_runtime;
    `);
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT SELECT ON ${table} TO batch_read_runtime`);
    await db.exec("SET ROLE batch_read_runtime");
    const query = async <T>(sql: string, values?: unknown[]): Promise<{rows: T[]}> => {calls.push(sql); return db.query<T>(sql, values);};
    const legacy: RentOpsQueryExecutor = {query};
    const batch = createRentOpsPoolExecutor({query, connect: async () => {throw new Error("Batch should not start a transaction");}});
    const oldRepository = createPostgresRentOpsRepository(legacy);
    const newRepository = createPostgresRentOpsRepository(batch);
    await oldRepository.assertReady(); await newRepository.assertReady();
    calls.length = 0;
    const legacyStart = performance.now();
    const oldOperational = await oldRepository.getOperationalSnapshot();
    const legacyMs = performance.now() - legacyStart;
    assert.equal(calls.length, 19);
    calls.length = 0;
    const batchStart = performance.now();
    const newOperational = await newRepository.getOperationalSnapshot();
    const batchMs = performance.now() - batchStart;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith("SELECT COALESCE("));
    assert.deepEqual(newOperational, oldOperational);
    assert.deepEqual(serializeAdminSnapshot(newOperational), serializeAdminSnapshot(oldOperational));
    assert.equal(newOperational.ledgerTransactions[0].amountCents, 2147483647);
    assert.equal(newOperational.securityDeposits[0].amountHeldCents, null);
    assert.equal(newOperational.tenancies[0].createdAt, "2026-01-01T06:30:00.123Z");
    assert.equal(newOperational.activityEvents[0].occurredAt, "2026-08-15T07:04:56.987Z");
    calls.length = 0;
    const oldWorkspace = await oldRepository.getWorkspaceSnapshot();
    assert.equal(calls.length, 7);
    calls.length = 0;
    const newWorkspace = await newRepository.getWorkspaceSnapshot();
    assert.equal(calls.length, 1);
    assert.deepEqual(newWorkspace, oldWorkspace);
    assert.equal(newWorkspace.modelVersion, oldOperational.modelVersion);
    assert.equal(newWorkspace.modelVersion, 3);
    const oldDto = serializeWorkspaceBootstrap(oldWorkspace, {asOfDate: "2026-08-15"});
    const newDto = serializeWorkspaceBootstrap(newWorkspace, {asOfDate: "2026-08-15"});
    assert.deepEqual({...newDto, generatedAt: undefined}, {...oldDto, generatedAt: undefined});
    // Complete row-level parity also checks JSON payloads intentionally omitted by presentation.
    const rawLegacy = await Promise.all(RENT_OPS_BATCH_TABLES.map(async table => (await query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows));
    const rawBatch = await batch.readTableBatch!(RENT_OPS_BATCH_TABLES);
    // numeric SQL types are strings in the driver but JSON numbers on aggregate reads;
    // their domain mapping equality was established above without changing nulls.
    assert.equal(rawBatch.rent_ops_applications[0].profile_answers && (rawBatch.rent_ops_applications[0].profile_answers as any).nested.created_at, "leave-this-string");
    assert.deepEqual(rawBatch.rent_ops_activity_events[0].metadata, rawLegacy[18][0].metadata);
    console.log(JSON.stringify({pgliteOperationalLegacyStatements: 19, pgliteOperationalBatchStatements: 1, legacyMs: Number(legacyMs.toFixed(2)), batchMs: Number(batchMs.toFixed(2))}));
  } finally {await db.close();}
});
