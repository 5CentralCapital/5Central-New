import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema} from '../persistence';
import {DATABASE_AUDIT_SQL} from './database-audit';

test('actual fidelity SQL counts source identity tuples without forbidden NUL or delimiter collisions',async()=>{
 const db=new PGlite();try{
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql)}});
  const metrics={recurring_schedule:'schedule',deposit:'deposit',subsidy:'hap_contract',subsidy_tenant:'hap_tenant',subsidy_payment:'hap_payment'};
  for(const [entityType]of Object.entries(metrics))for(const [i,system,sourceId]of [[0,'a',':b'],[1,'a:','b']] as const){
   await db.query('INSERT INTO rent_ops_source_records(id,system,entity_type,source_id,target_id) VALUES ($1,$2,$3,$4,$5)',[entityType+i,system,entityType,sourceId,'target'+i]);
  }
  const result=await db.query<Record<string,unknown>>(DATABASE_AUDIT_SQL.fidelityControls,['2026-09-07']);
  for(const prefix of Object.values(metrics))assert.equal(Number(result.rows[0][prefix+'_distinct_source_identity_count']),2,prefix);
 }finally{await db.close()}
});
