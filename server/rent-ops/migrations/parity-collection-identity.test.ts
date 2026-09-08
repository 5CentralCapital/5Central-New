import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema} from '../persistence';
import {createRestrictedImportObservationFromChunks} from '../import/restricted-parity';
import {persistRestrictedParityObservation} from '../import/restricted-parity-persistence';
test('actual generated collection identities persist intact and replay without duplicates',async()=>{
 const db=new PGlite();try{
 await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql)}});
 await db.query("INSERT INTO rent_ops_import_runs(id,system,started_at,mode) VALUES ('run','rent_manager','2026-09-07T00:00:00Z','apply')");
 const sourceChunks=[{path:'payload.empty',present:true,rows:[]},{path:'payload.absent',present:false,rows:[]}];
 const sourceManifestSha256='b'.repeat(64);
 const observation=createRestrictedImportObservationFromChunks({sourceEnvelopeSha256:'a'.repeat(64),sourceRunId:'source-run',importRunId:'run',observedAt:'2026-09-07T00:00:00.000Z',sourceManifestSha256,sourceChunks});
 const input={observation,sourceManifestSha256,sourceChunks};
 const first=await persistRestrictedParityObservation(db,input);const second=await persistRestrictedParityObservation(db,input);
 assert.deepEqual(second,first);
 const rows=await db.query<{id:string,path:string}>('SELECT id,path FROM rent_ops_restricted_parity_collection_occurrences ORDER BY occurrence_ordinal');
 assert.equal(rows.rows.length,2);for(const row of rows.rows)assert.equal(row.id.length,162);
 assert.deepEqual(rows.rows.map(row=>row.path),['payload.empty','payload.absent']);
 }finally{await db.close()}
});
