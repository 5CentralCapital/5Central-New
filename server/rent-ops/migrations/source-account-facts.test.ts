import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema,RENT_OPS_RUNTIME_REQUIRED_TABLES} from '../persistence';
import {PostgresRentOpsRepository} from '../repositories/postgres';
test('source account facts persist without altering occupancy and reject incomplete evidence',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql)}});
  const repo=new PostgresRentOpsRepository({query:(sql,params)=>db.query(sql,params)});
  const sourceAccountFacts={status:'past' as const,rawStatus:'Past',statusKnowledge:'source' as const,postingStartOn:'2025-01-01',postingEndOn:'2026-06-30',postingStartKnowledge:'source' as const,postingEndKnowledge:'source' as const,observedOn:'2026-09-07',artifactSha256:'a'.repeat(64)};
  await db.query('INSERT INTO rent_ops_people(id,first_name,last_name,source_account_facts) VALUES($1,$2,$3,$4)',['synthetic-account','Synthetic','Former',JSON.stringify(sourceAccountFacts)]);
  await db.exec('CREATE ROLE account_reader; GRANT USAGE ON SCHEMA public TO account_reader; GRANT SELECT ON '+RENT_OPS_RUNTIME_REQUIRED_TABLES.join(',')+' TO account_reader; SET ROLE account_reader');
  assert.deepEqual((await repo.getSnapshot()).people[0].sourceAccountFacts,sourceAccountFacts);
  await db.exec('RESET ROLE');
  for(const facts of [{},{...sourceAccountFacts,artifactSha256:null},{...sourceAccountFacts,status:'invented'},{...sourceAccountFacts,status:null},{...sourceAccountFacts,postingEndOn:null}]){
   await assert.rejects(db.query('UPDATE rent_ops_people SET source_account_facts=$1 WHERE id=$2',[JSON.stringify(facts),'synthetic-account']));
  }
  await db.exec('SET ROLE account_reader');
  assert.equal((await repo.getSnapshot()).tenancies.length,0);
 }finally{await db.close()}
});
