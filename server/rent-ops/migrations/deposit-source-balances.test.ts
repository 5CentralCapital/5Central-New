import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { mapRentManagerExport, moneyControlCounts } from '../import/rm-mapper';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { deriveDepositLiability } from '../domain/reports';
import { serializeAdminSecurityDeposit } from '../presentation/entities';

test('signed source summary maps and persists as unknown held; report and DTO never turn it into zero',async()=>{
 const input={deposits:[{sourceId:'negative-summary',amount:-1550}]};
 const result=mapRentManagerExport(input,{fidelityVersion:3,artifactSha256:'a'.repeat(64),artifactObservationOn:'2026-09-07'});
 assert.equal(result.snapshot.securityDeposits.length,1);
 const deposit=result.snapshot.securityDeposits[0];
 assert.equal(deposit.amountHeldCents,null);assert.equal(deposit.sourceBalanceCents,-155000);
 assert.equal(moneyControlCounts(input).knownTotals.deposits,-155000);assert.equal(moneyControlCounts(input).invalidCounts.deposits,0);
 assert.equal(result.exceptions.some(e=>e.entityType==='deposit'&&e.severity==='error'),false);
 const db=new PGlite();
 try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  const executor:RentOpsQueryExecutor={async query<T>(sql:string,args?:unknown[]){if(sql.includes('has_table_privilege'))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return db.query<T>(sql,args?.map(v=>v===undefined?null:v));}};
  await db.exec("CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
  const repo=new PostgresRentOpsRepository(executor);await repo.saveSecurityDeposit(deposit);
  const snapshot=await repo.getSnapshot();assert.equal(snapshot.securityDeposits[0].amountHeldCents,null);assert.equal(snapshot.securityDeposits[0].sourceBalanceCents,-155000);
  const rows=deriveDepositLiability(snapshot,{asOfDate:'2026-09-07'});assert.equal(rows[0].totalHeldCents,null);assert.equal(rows[0].sourceBalanceCents,-155000);assert.equal(rows[0].unknownHeldCount,1);
  await db.exec("RESET ROLE");
  await assert.rejects(db.query("UPDATE rent_ops_security_deposits SET source_balance_cents=-1 WHERE id=$1",[deposit.id]),/immutable/);
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql);}});
  assert.equal((await db.query("SELECT source_balance_cents FROM rent_ops_security_deposits")).rows.length,1);
  const dto=serializeAdminSecurityDeposit(snapshot.securityDeposits[0]);assert.equal(dto.amountHeldCents,null);assert.equal(dto.sourceBalanceCents,-155000);
  await assert.rejects(db.exec("INSERT INTO rent_ops_security_deposits(id,amount_held_cents,source_balance_cents) VALUES('forged',NULL,-155000)"),/check constraint/);
  await assert.rejects(db.exec("INSERT INTO rent_ops_security_deposits(id,amount_held_cents) VALUES('negative-held',-155000)"),/check constraint/);
 }finally{await db.close();}
});
