import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import {ensureRentOpsSchema,RENT_OPS_MIGRATION_REQUIRED_TABLES} from '../persistence';
import {RENT_OPS_APPLICATION_TABLES} from '../security/deployment-security';
const connectionString=process.env.RENT_OPS_SCHEMA_VISIBILITY_TEST_URL;
test('schema completeness is independent of importer application-table permissions', {skip:!connectionString}, async()=>{
 const url=new URL(connectionString!);
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55441');assert.equal(url.pathname,'/schema_visibility_test');
 const pool=new pg.Pool({connectionString});
 try{
  const client=await pool.connect();
  try{
   if(!(await client.query("SELECT to_regclass('public.rent_ops_schema_migrations') AS existing")).rows[0].existing) await ensureRentOpsSchema({apply:true,executor:async sql=>{await client.query(sql);}});
   await client.query('BEGIN');
   await client.query('CREATE ROLE schema_visibility_importer NOLOGIN NOINHERIT');
   await client.query('GRANT USAGE ON SCHEMA public TO schema_visibility_importer');
   for(const table of RENT_OPS_MIGRATION_REQUIRED_TABLES.filter(t=>!(RENT_OPS_APPLICATION_TABLES as readonly string[]).includes(t))) await client.query(`GRANT SELECT ON public.${table} TO schema_visibility_importer`);
   await client.query('SET LOCAL ROLE schema_visibility_importer');
   const visible=await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",[RENT_OPS_MIGRATION_REQUIRED_TABLES]);
   assert.equal(visible.rowCount,RENT_OPS_MIGRATION_REQUIRED_TABLES.length-RENT_OPS_APPLICATION_TABLES.length);
   // Exercise the actual SQL literals in both production preconditions, including the private persistence seam.
   for(const filename of ['database-audit.ts','persistence-importer.ts']){
    const source=readFileSync(new URL(filename,import.meta.url),'utf8');
    const sql=source.match(/"(SELECT c\.relname AS table_name FROM pg_catalog\.pg_class[^"\n]+)"/)?.[1];
    assert.ok(sql,`${filename} must inspect catalog existence`);
    const result=await client.query(sql,[RENT_OPS_MIGRATION_REQUIRED_TABLES]);
    assert.deepEqual(result.rows.map(r=>r.table_name).sort(),[...RENT_OPS_MIGRATION_REQUIRED_TABLES].sort());
    const absent=await client.query(sql,[['rent_ops_nonexistent_table']]);assert.equal(absent.rowCount,0);
   }
   for(const table of RENT_OPS_APPLICATION_TABLES){
    await client.query('SAVEPOINT denied_read');
    await assert.rejects(client.query(`SELECT * FROM public.${table} LIMIT 0`),(error:any)=>error.code==='42501');
    await client.query('ROLLBACK TO SAVEPOINT denied_read');
   }
  }finally{await client.query('ROLLBACK');client.release();}
 }finally{await pool.end();}
});
