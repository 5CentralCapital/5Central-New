import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../export/hash";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import {
  auditRestrictedParityStream,
  auditPersistedRestrictedParity,
  createRestrictedParityPersistenceWriter,
  persistRestrictedParityObservation,
  readRestrictedParityAggregateControls,
  type RestrictedParityAggregateControls,
  type RestrictedParityPersistenceInput,
} from "./restricted-parity-persistence";
import { createRestrictedImportObservationFromChunks, type RestrictedParitySourceChunk } from "./restricted-parity";

type TableRow = Record<string, unknown>;

class InMemoryRestrictedExecutor implements RentOpsQueryExecutor {
  readonly observations = new Map<string, TableRow>();
  readonly collections = new Map<string, TableRow>();
  readonly rows = new Map<string, TableRow>();

  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (text.includes("rent_ops_restricted_parity_observations")) {
      if (text.startsWith("INSERT")) {
        const row: TableRow = {
          id: values[0], version: values[1], source: values[2], source_run_id: values[3], import_run_id: values[4], observed_at: values[5], source_envelope_sha256: values[6], source_manifest_sha256: values[7], source_rows_sha256: values[8], collections_sha256: values[9], collection_occurrence_count: values[10], collection_occurrence_order_sha256: values[11], collection_occurrence_set_sha256: values[12], row_occurrence_count: values[13], row_occurrence_order_sha256: values[14], row_occurrence_set_sha256: values[15], source_identity_order_sha256: values[16], source_schema_version: values[17], source_registry_sha256: values[18], source_checkpoint_sha256: values[19], source_coverage_sha256: values[20], source_control_sha256: values[21],
        };
        if (this.observations.has(String(row.id))) return { rows: [] as T[] };
        this.observations.set(String(row.id), row);
        return { rows: [row as T] };
      }
      return { rows: [this.observations.get(String(values[0]))].filter(Boolean) as T[] };
    }
    for (const [table, stored] of [["rent_ops_restricted_parity_collection_occurrences",this.collections],["rent_ops_restricted_parity_row_occurrences",this.rows]] as const) {
      if (!text.includes(table)) continue;
      if (text.startsWith("INSERT")) {
        const fields=text.slice(text.indexOf("(")+1,text.indexOf(")")).split(",").map(x=>x.trim());
        const inserted:TableRow[]=[];
        for(let offset=0;offset<values.length;offset+=fields.length){
          const row=Object.fromEntries(fields.map((field,index)=>[field,values[offset+index]]));
          if(!stored.has(String(row.id))){stored.set(String(row.id),row);inserted.push(row);}
        }
        return {rows:inserted as T[]};
      }
      if(text.includes("WHERE id = ANY"))return {rows:(values[0] as string[]).map(id=>stored.get(id)).filter(Boolean) as T[]};
      const result=Array.from(stored.values()).filter(row=>row.observation_id===values[0]).sort((left,right)=>Number(left.occurrence_ordinal)-Number(right.occurrence_ordinal));
      return {rows:result.slice(0,Number(values[1]??result.length)) as T[]};
    }
    throw new Error("unexpected_query");
  }
}

class PayloadAuditExecutor extends InMemoryRestrictedExecutor {
  payloadRows: TableRow[] = [];

  override async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (text.includes("FROM rent_ops_source_payloads")) return { rows: this.payloadRows as T[] };
    return super.query<T>(text, values);
  }
}

function row(system: string, sourceCollection: string, sourceId: string, value: string) {
  const canonicalPayload = JSON.stringify({ sourceId, value });
  return { system, sourceCollection, sourceId, canonicalPayload, checksumSha256: sha256(canonicalPayload) };
}

function input(): { value: RestrictedParityPersistenceInput; chunks: readonly RestrictedParitySourceChunk[] } {
  const chunks: readonly RestrictedParitySourceChunk[] = [
    { path: "payload.contacts", present: true, rows: [row("rent_manager", "contacts", "contact-1", "same"), row("rent_manager", "contacts", "contact-1", "same")] },
    { path: "payload.contacts", present: true, rows: [row("rent_manager", "contacts", "contact-2", "second")] },
    { path: "payload.empty", present: true, rows: [] },
    { path: "payload.absent", present: false, rows: [] },
  ];
  const observation = createRestrictedImportObservationFromChunks({
    sourceEnvelopeSha256: "a".repeat(64),
    sourceRunId: "source-run-1",
    importRunId: "import-run-1",
    observedAt: "2026-08-17T12:00:00.000Z",
    sourceManifestSha256: "b".repeat(64),
    sourceChunks: chunks,
  });
  return {
    chunks,
    value: { observation, sourceManifestSha256: "b".repeat(64), sourceChunks: chunks },
  };
}

test("restricted parity persistence retains duplicate, ordered, empty, and absent occurrences", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const controls = await persistRestrictedParityObservation(executor, fixture.value);
  assert.equal(controls.collectionOccurrences.length, 4);
  assert.equal(controls.rowOccurrences.length, 3);
  assert.equal(controls.rowOccurrences[0]?.identitySha256, controls.rowOccurrences[1]?.identitySha256);
  assert.equal("sourceId" in controls.rowOccurrences[0]!, false);
  assert.equal(controls.collectionOccurrences[2]?.present, true);
  assert.equal(controls.collectionOccurrences[2]?.rowCount, 0);
  assert.equal(controls.collectionOccurrences[3]?.present, false);
  assert.equal(controls.collectionOccurrences[3]?.rowCount, 0);
  assert.equal(JSON.stringify(controls).includes("contact-1"), false);
  assert.equal(executor.rows.size, 3, "row occurrence storage must not deduplicate equal identities");
  assert.equal(executor.collections.size, 4, "collection occurrence storage must preserve repeated paths");
});

test("writer retries are insert-only and idempotent after exact conflict verification", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const writer = createRestrictedParityPersistenceWriter();
  const first = await writer(executor, fixture.value);
  const second = await writer(executor, fixture.value);
  assert.deepEqual(second, first);
});

test("bounded aggregate readback contains controls only and audits the database stream", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const expected = await persistRestrictedParityObservation(executor, fixture.value);
  const actual = await readRestrictedParityAggregateControls(executor, expected.observationId);
  const report = auditRestrictedParityStream({ expected: fixture.value, actual });
  assert.equal(report.passed, true);
  assert.deepEqual(report.blockingReasons, []);
  assert.equal(report.duplicateExpectedOccurrences, 1);
  assert.equal(report.duplicateActualOccurrences, 1);
  assert.equal(JSON.stringify(report).includes("contact-1"), false);
});

test("stream audit catches missing, extra, reorder, duplicate, and empty-vs-absent tampering", async () => {
  const fixture = input();
  const executor = new InMemoryRestrictedExecutor();
  const expected = await persistRestrictedParityObservation(executor, fixture.value);
  const tampered = (mutate: (copy: RestrictedParityAggregateControls) => void): ReturnType<typeof auditRestrictedParityStream> => {
    const copy: RestrictedParityAggregateControls = {
      ...expected,
      collectionOccurrences: expected.collectionOccurrences.map((value) => ({ ...value })),
      rowOccurrences: expected.rowOccurrences.map((value) => ({ ...value })),
    };
    mutate(copy);
    return auditRestrictedParityStream({ expected: fixture.value, actual: copy });
  };
  assert.ok(tampered((copy) => { (copy.rowOccurrences as Array<unknown>).splice(0, 1); }).blockingReasons.includes("restricted_parity_row_occurrence_count_mismatch"));
  assert.ok(tampered((copy) => { (copy.rowOccurrences as Array<unknown>).push({ ...copy.rowOccurrences[0]! }); }).blockingReasons.includes("restricted_parity_row_occurrence_count_mismatch"));
  assert.ok(tampered((copy) => { const rows = copy.rowOccurrences as Array<unknown>; [rows[0], rows[1]] = [rows[1], rows[0]]; }).blockingReasons.includes("restricted_parity_row_occurrence_order_mismatch"));
  assert.ok(tampered((copy) => { const rows = copy.rowOccurrences as Array<unknown>; rows[1] = { ...rows[1]!, checksumSha256: "c".repeat(64) }; }).blockingReasons.includes("restricted_parity_row_occurrence_order_mismatch"));
  assert.ok(tampered((copy) => { const collections = copy.collectionOccurrences as Array<Record<string, unknown>>; collections[2]!.present = false; }).blockingReasons.includes("restricted_parity_empty_presence_mismatch"));
});

test("source checksum binding fails before any persistence query", async () => {
  const fixture = input();
  const bad = { ...fixture.value, sourceChunks: [{ ...fixture.chunks[0]!, rows: [{ ...fixture.chunks[0]!.rows[0]!, checksumSha256: "d".repeat(64) }] }] };
  await assert.rejects(() => persistRestrictedParityObservation(new InMemoryRestrictedExecutor(), bad), /restricted_parity_source_checksum_binding_invalid/u);
});

test("postcommit restricted audit checks payload checksum/canonical binding without returning payload values", async () => {
  const fixture = input();
  const executor = new PayloadAuditExecutor();
  const controls = await persistRestrictedParityObservation(executor, fixture.value);
  const firstRow = fixture.chunks[0]!.rows[0]!;
  const payloadId = `rm-payload:${sha256(`rent_manager\u0000contacts\u0000contact-1\u0000${firstRow.checksumSha256}`)}`;
  const expectedPayload = { id: payloadId, system: "rent_manager", sourceCollection: "contacts", sourceId: "contact-1", checksumSha256: firstRow.checksumSha256, importRunId: "import-run-1", canonicalPayload: firstRow.canonicalPayload };
  executor.payloadRows = [{ id: payloadId, system: "rent_manager", source_collection: "contacts", source_id: "contact-1", checksum_sha256: firstRow.checksumSha256, import_run_id: "import-run-1", payload: firstRow.canonicalPayload }];
  const passed = await auditPersistedRestrictedParity(executor, { ...fixture.value, payloadBindings: [expectedPayload] });
  assert.equal(passed.passed, true);
  assert.equal(JSON.stringify(passed).includes(firstRow.canonicalPayload), false);
  executor.payloadRows[0]!.checksum_sha256 = "e".repeat(64);
  const tampered = await auditPersistedRestrictedParity(executor, { ...fixture.value, payloadBindings: [expectedPayload] });
  assert.equal(tampered.passed, false);
  assert.ok(tampered.blockingReasons.includes("restricted_parity_payload_binding_mismatch"));
  assert.equal(controls.observationId.length > 0, true);
});

test('PGlite bounded occurrence INSERT and exact replay preserve full fields across batch boundary',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const {readFile}=await import('node:fs/promises');
 const db=new PGlite();
 try{
  // Use the actual occurrence-table DDL, with only its import-run FK parent stubbed.
  const migration=await readFile(new URL('../migrations/005_rent_ops_restricted_occurrences.sql',import.meta.url),'utf8');
  await db.exec("CREATE TABLE rent_ops_source_payloads(system text,source_collection text,source_id text,checksum_sha256 varchar(64),PRIMARY KEY(system,source_collection,source_id,checksum_sha256)); CREATE TABLE rent_ops_import_runs(id varchar(160) PRIMARY KEY); INSERT INTO rent_ops_import_runs VALUES ('import-run-1');");
  await db.exec(migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS rent_ops_restricted_parity_observations'),migration.indexOf('-- The parity tables')));
  await db.exec('ALTER TABLE rent_ops_restricted_parity_collection_occurrences ALTER COLUMN id TYPE varchar(192)'); // schema 22 identity width
  const chunks:RestrictedParitySourceChunk[]=[{path:'payload.contacts',present:true,rows:Array.from({length:501},(_,index)=>row('rent_manager','contacts',`qa-${index}`,'synthetic'))}];
  await db.query(`INSERT INTO rent_ops_source_payloads SELECT x.system,x."sourceCollection",x."sourceId",x."checksumSha256" FROM jsonb_to_recordset($1::jsonb) AS x(system text,"sourceCollection" text,"sourceId" text,"checksumSha256" text)`,[JSON.stringify(Array.from(chunks[0].rows))]);
  const observation=createRestrictedImportObservationFromChunks({sourceEnvelopeSha256:'a'.repeat(64),sourceRunId:'source-run-1',importRunId:'import-run-1',observedAt:'2026-08-17T12:00:00.000Z',sourceManifestSha256:'b'.repeat(64),sourceChunks:chunks});
  const value={observation,sourceManifestSha256:'b'.repeat(64),sourceChunks:chunks};
  const statements:Array<{sql:string;count:number}>=[];
  const executor:RentOpsQueryExecutor={query:async<T>(sql:string,values:unknown[]=[])=>{statements.push({sql,count:values.length});return db.query<T>(sql,values);}};
  await db.exec('BEGIN');
  const first=await persistRestrictedParityObservation(executor,value);
  await db.exec('COMMIT');
  assert.equal(statements.length,4,'header + collection + two row batches replaces 503 inserts');
  assert.ok(statements.every(x=>x.count<=5500));
  statements.length=0;
  await db.exec('BEGIN');
  assert.deepEqual(await persistRestrictedParityObservation(executor,value),first);
  await db.exec('COMMIT');
  assert.equal(statements.length,8,'exact replay needs two statements per batch, not 1006 per-row queries');
  const controls=await readRestrictedParityAggregateControls(executor,first.observationId);
  assert.deepEqual(controls,first);
  // Each corruption retains the same primary ID and count. Full-field readback
  // must detect it even though all other occurrence hashes are unchanged.
  for(const [table,field,changed]of [
   ['rent_ops_restricted_parity_row_occurrences','source_id','different-source'],
   ['rent_ops_restricted_parity_row_occurrences','system','different-system'],
   ['rent_ops_restricted_parity_row_occurrences','source_collection','different-collection'],
   ['rent_ops_restricted_parity_row_occurrences','collection_path','different-path'],
   ['rent_ops_restricted_parity_row_occurrences','row_digest_sha256','d'.repeat(64)],
   ['rent_ops_restricted_parity_row_occurrences','checksum_sha256','e'.repeat(64)],
   ['rent_ops_restricted_parity_collection_occurrences','path','different-path'],
   ['rent_ops_restricted_parity_observations','source','different-source'],
  ]as const){
   await db.exec('BEGIN');
   if(table==='rent_ops_restricted_parity_row_occurrences'&&['source_id','system','source_collection','checksum_sha256'].includes(field)){
    const original=(await db.query<Record<string,unknown>>(`SELECT system,source_collection,source_id,checksum_sha256 FROM ${table} ORDER BY id LIMIT 1`)).rows[0];
    original[field]=changed;await db.query('INSERT INTO rent_ops_source_payloads VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[original.system,original.source_collection,original.source_id,original.checksum_sha256]);
   }
   await db.query(`UPDATE ${table} SET ${field}=$1 WHERE id=(SELECT id FROM ${table} ORDER BY id LIMIT 1)`,[changed]);
   await assert.rejects(persistRestrictedParityObservation(executor,value),/restricted_parity_persistence_insert_conflict/);
   await db.exec('ROLLBACK');
  }
  // Mixed pre-existing and new rows are verified without relying on RETURNING order.
  await db.exec('BEGIN');await db.exec('DELETE FROM rent_ops_restricted_parity_row_occurrences WHERE occurrence_ordinal=500');
  statements.length=0;await persistRestrictedParityObservation(executor,value);
  assert.equal(statements.length,7);
  await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('duplicate explicit occurrence ordinals are rejected before any SQL',async()=>{
 const fixture=input();const repeated={occurrenceOrdinal:0,collectionOccurrenceOrdinal:0,collectionPath:'payload.contacts',rowOrdinal:0,system:'rent_manager',sourceCollection:'contacts',sourceId:'qa',checksumSha256:'a'.repeat(64),rowDigestSha256:'b'.repeat(64)};
 let calls=0;const executor:RentOpsQueryExecutor={query:async()=>{calls++;return {rows:[]};}};
 await assert.rejects(persistRestrictedParityObservation(executor,{...fixture.value,sourceChunks:undefined,rowOccurrences:[repeated,repeated]}),/restricted_parity_row_order_invalid/);
 assert.equal(calls,0);
});
