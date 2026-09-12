import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {rentOpsMigrationDefinitions,RENT_OPS_RUNTIME_REQUIRED_TABLES,RENT_OPS_SCHEMA_VERSION} from '../persistence';
import {createPostgresRentOpsRepository,type RentOpsQueryExecutor} from './postgres';

test('actual runtime role reads migration checksums while readiness rejects every migration write and restricted read',async()=>{
 const db=new PGlite();try{
  for(const migration of rentOpsMigrationDefinitions())await db.exec(migration.renderedSql);
  await db.exec('CREATE ROLE runtime_metadata_test; GRANT USAGE ON SCHEMA public TO runtime_metadata_test;');
  await db.exec('GRANT SELECT ON '+RENT_OPS_RUNTIME_REQUIRED_TABLES.map(t=>'public."'+t+'"').join(',')+' TO runtime_metadata_test');
  const executor:RentOpsQueryExecutor={query:async<T>(sql:string,values?:unknown[])=>({rows:(await db.query(sql,values)).rows as T[]}),transaction:async(work)=>work(executor)};
  await db.exec('SET ROLE runtime_metadata_test');
  assert.equal((await db.query('SELECT version,checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version')).rows.length,RENT_OPS_SCHEMA_VERSION);
  await assert.rejects(db.query("UPDATE rent_ops_schema_migrations SET checksum_sha256='denied' WHERE version=$1",[RENT_OPS_SCHEMA_VERSION]), /permission denied/);
  await createPostgresRentOpsRepository(executor).getSnapshot();
  for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
   await db.exec('RESET ROLE; GRANT '+privilege+' ON rent_ops_schema_migrations TO runtime_metadata_test; SET ROLE runtime_metadata_test');
   await assert.rejects(createPostgresRentOpsRepository(executor).getSnapshot(),/forbidden table privilege/);
   await db.exec('RESET ROLE; REVOKE '+privilege+' ON rent_ops_schema_migrations FROM runtime_metadata_test; SET ROLE runtime_metadata_test');
  }
  for(const table of ['rent_ops_schema_meta','rent_ops_source_records','rent_ops_source_payloads']){
   await db.exec('RESET ROLE; GRANT SELECT ON '+table+' TO runtime_metadata_test; SET ROLE runtime_metadata_test');
   await assert.rejects(createPostgresRentOpsRepository(executor).getSnapshot(),/forbidden table privilege/);
   await db.exec('RESET ROLE; REVOKE SELECT ON '+table+' FROM runtime_metadata_test; SET ROLE runtime_metadata_test');
  }
 }finally{await db.close();}
});
