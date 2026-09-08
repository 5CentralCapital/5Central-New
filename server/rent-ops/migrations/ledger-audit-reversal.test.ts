import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { DATABASE_AUDIT_SQL } from '../import/database-audit';
import { deriveTenantLedger } from '../domain/reports';
import type { RentOpsLedgerTransaction, RentOpsPaymentAllocation } from '../../../shared/rent-ops-contracts';

test('PostgreSQL audit correlates each reversal to its outer ledger original',async()=>{
 const db=new PGlite();try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);},query:sql=>db.query(sql)});
  const repeated = await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);},query:sql=>db.query(sql)});
  assert.equal(repeated.statementCount,2,"Installed migration chain must only begin and commit on repeat");
  const executor:RentOpsQueryExecutor={async query<T>(sql,args){if(sql.includes('has_table_privilege'))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return db.query<T>(sql,args?.map(v=>v===undefined?null:v));}};
  const repo=new PostgresRentOpsRepository(executor);
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES('p','p');INSERT INTO rent_ops_units(id,property_id,property_link_knowledge)VALUES('u','p','manual');INSERT INTO rent_ops_people(id)VALUES('person');INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');`);
  const base:RentOpsLedgerTransaction={id:'charge',propertyId:'p',unitId:'u',personId:'person',tenancyId:'t',kind:'charge',category:'base_rent',categoryKnowledge:'manual',status:'posted',amountCents:10000,postedOn:'2026-09-01',dueOn:null,dueOnKnowledge:'unknown',description:'Rent',payer:'tenant',payerKnowledge:'manual',propertyLinkKnowledge:'manual',unitLinkKnowledge:'manual',personLinkKnowledge:'manual',tenancyLinkKnowledge:'manual',amountKnowledge:'known',postedOnKnowledge:'manual',statusKnowledge:'manual',descriptionKnowledge:'manual',chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown',paymentMethod:null,paymentMethodKnowledge:'unknown'};
  for (const [kind,direction,amount] of [['payment',null,10000],['credit',null,2000],['charge',null,5000],['adjustment','debit',3000],['adjustment','credit',1000]] as const) {
    const id=`original-${kind}-${direction}`;
    await repo.saveLedgerTransaction({...base,id,kind,adjustmentDirection:direction,amountCents:amount});
    await repo.saveLedgerTransaction({...base,id:`reverse-${id}`,kind:'reversal',reversalOfId:id,adjustmentDirection:null,amountCents:amount,postedOn:'2026-09-02'});
  }
  await repo.saveLedgerTransaction({...base,id:'outstanding',amountCents:777});
  const result=await db.query<Record<string,unknown>>(DATABASE_AUDIT_SQL.totals);
  assert.equal(Number(result.rows[0].net_ledger_cents),777);
  assert.equal(Number(result.rows[0].net_ledger_balance_cents),777);
 }finally{await db.close();}
});
