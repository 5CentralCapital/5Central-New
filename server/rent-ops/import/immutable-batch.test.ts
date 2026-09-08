import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {upsertCollection,PERSISTENCE_IMPORT_BATCH_SIZE,PersistenceImportPreconditionError} from './persistence-importer';
test('immutable batches preserve complete rows and source identities through insert, replay and boundary conflicts',async()=>{
 const db=new PGlite();let reads=0,maxParams=0;
 const executor={query:async<T>(sql:string,args:unknown[]=[])=>{if(sql.startsWith('SELECT'))reads++;maxParams=Math.max(maxParams,args.length);return await db.query<T>(sql,args);}};
 try{
  await db.exec('CREATE TABLE immutable_batch_test(id varchar PRIMARY KEY,source_system varchar,source_id varchar,amount integer,payload jsonb,occurred_on date,description text)');
  const n=PERSISTENCE_IMPORT_BATCH_SIZE*2+1;
  const records=Array.from({length:n},(_,i)=>[`id-${i}`,'rm',`source-${i}`,i,JSON.stringify({b:2,a:i}),'2026-09-08',`label-${i}`]);
  const descriptor={name:'batch_test',table:'immutable_batch_test',columns:['id','source_system','source_id','amount','payload','occurred_on','description'],records,values:(r:unknown)=>r as unknown[],immutable:true};
  const original=(await db.query('SELECT * FROM immutable_batch_test')).rows;assert.equal(original.length,0);
  await upsertCollection(executor,descriptor);assert.equal(reads,12); // 3 batches x ID/source x before/after, formerly804 reads.
  assert.ok(maxParams<=700);
  const inserted=(await db.query('SELECT * FROM immutable_batch_test ORDER BY id')).rows;
  reads=0;await upsertCollection(executor,descriptor);assert.equal(reads,12);assert.deepEqual((await db.query('SELECT * FROM immutable_batch_test ORDER BY id')).rows,inserted);
  for(const index of [0,99,100,200]){
   for(const field of [3,4,5,6]){
    const changed=records.map(r=>[...r]);changed[index][field]=field===3?999:field===4?'{}':field===5?'2026-09-09':'different';
    await assert.rejects(upsertCollection(executor,{...descriptor,records:changed}),(e:unknown)=>e instanceof PersistenceImportPreconditionError&&e.reasons.includes('immutable_batch_test_conflict'));
   }
   const differentId=records.map(r=>[...r]);differentId[index][0]='different-id';
   await assert.rejects(upsertCollection(executor,{...descriptor,records:differentId}),(e:unknown)=>e instanceof PersistenceImportPreconditionError&&e.reasons.includes('immutable_batch_test_source_conflict'));
  }
  assert.deepEqual((await db.query('SELECT * FROM immutable_batch_test ORDER BY id')).rows,inserted);
  // Post-insert verification must remain active even after a clean preflight.
  let injected=false;
  const racing={query:async<T>(sql:string,args:unknown[]=[])=>{
   const result=await executor.query<T>(sql,args);
   if(!injected&&sql.startsWith('INSERT')){injected=true;await db.query("UPDATE immutable_batch_test SET description='changed-after-preflight' WHERE id='id-200'");}
   return result;
  }};
  await assert.rejects(upsertCollection(racing,descriptor),/immutable_batch_test_conflict/);
  await db.query("UPDATE immutable_batch_test SET description='label-200' WHERE id='id-200'");
  // A different existing ID with the same source tuple must never be hidden by an ID match.
  await db.query("INSERT INTO immutable_batch_test SELECT 'duplicate-source',source_system,source_id,amount,payload,occurred_on,description FROM immutable_batch_test WHERE id='id-100'");
  await assert.rejects(upsertCollection(executor,descriptor),/immutable_batch_test_source_conflict/);
 }finally{await db.close();}
});
