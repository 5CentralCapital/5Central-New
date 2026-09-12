import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema,RENT_OPS_RUNTIME_REQUIRED_TABLES} from '../persistence';
import {PostgresRentOpsRepository} from '../repositories/postgres';
import {applyOwnerVacancy} from '../reconciliation/vacancy-confirmation';
import {RentOpsService} from '../services/service';
test('manual occupancy observation roundtrips under runtime role and end patch preserves actual dates',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql)}});
  await db.exec("CREATE ROLE occupancy_operator; GRANT USAGE ON SCHEMA public TO occupancy_operator");
  for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table==='rent_ops_schema_migrations'?'SELECT':'SELECT,INSERT,UPDATE'} ON ${table} TO occupancy_operator`);
  await db.exec("SET ROLE occupancy_operator; INSERT INTO rent_ops_properties(id,name,slug) VALUES('p','QA','qa'); INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual'); INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('r','QA','Resident')");
  const repo=new PostgresRentOpsRepository({query:(sql,params)=>db.query(sql,params?.map(v=>v===undefined?null:v)),transaction:work=>db.transaction(tx=>work({query:(sql,params)=>tx.query(sql,params?.map(v=>v===undefined?null:v))}))});
  const service=new RentOpsService(repo,()=>new Date('2026-09-12T12:00:00Z'));
  await service.saveTenancy({id:'t',propertyId:'p',unitId:'u',primaryPersonId:'r',status:'current',occupancyConfirmedOn:'2026-09-08',occupancyConfirmationKnowledge:'manual',actualMoveInKnowledge:'unknown',createdAt:'2026-09-12T12:00:00Z'});
  const before=(await repo.getSnapshot()).tenancies[0];
  assert.equal(before.actualMoveInOn,undefined);assert.equal(before.occupancyConfirmedOn,'2026-09-08');assert.equal(before.occupancyConfirmationKnowledge,'manual');
  await assert.rejects(applyOwnerVacancy(repo,'u',1,'2026-09-12',{actorSubject:'qa',occurredAt:'2026-09-12T12:00:00Z'}),/Current or future/);
  await repo.applyRecordPatch!({entityType:'tenancy',targetId:'t',expectedRevision:1,nextRevision:2,values:{operational_end_confirmed_on:'2026-09-12',operational_end_confirmation_knowledge:'manual'}});
  const after=(await repo.getSnapshot()).tenancies[0];assert.equal(after.operationalEndConfirmedOn,'2026-09-12');assert.equal(after.actualMoveOutOn,undefined);assert.equal(after.actualMoveInOn,undefined);
  await assert.rejects(applyOwnerVacancy(repo,'u',1,'2026-09-13',{actorSubject:'qa',occurredAt:'2026-09-13T01:00:00Z'}),/Valid dated/);
  await applyOwnerVacancy(repo,'u',1,'2026-09-12',{actorSubject:'qa',occurredAt:'2026-09-12T12:00:00Z'});
  const vacant=(await repo.getSnapshot()).units[0];assert.equal(vacant.vacancyConfirmedOn,'2026-09-12');assert.equal(vacant.recordRevision,2);
  await assert.rejects(applyOwnerVacancy(repo,'u',1,'2026-09-12',{actorSubject:'qa',occurredAt:'2026-09-12T12:00:00Z'}),/revision/);
  await service.saveTenancy({id:'next',propertyId:'p',unitId:'u',primaryPersonId:'r',status:'current',actualMoveInOn:'2026-09-12',createdAt:'2026-09-12T12:00:00Z'});
  await assert.rejects(db.query("INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,actual_move_in_on,created_at) VALUES('duplicate','p','u','r','current','2026-09-12',NOW())"),/unique/);
  assert.equal((await repo.getSnapshot()).tenancies.length,2);
  await assert.rejects(db.query("UPDATE rent_ops_tenancies SET occupancy_confirmation_knowledge=NULL WHERE id='t'"));
 }finally{await db.close()}
});
