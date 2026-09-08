import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema,RENT_OPS_RUNTIME_REQUIRED_TABLES} from '../persistence';
import {PostgresRentOpsRepository} from '../repositories/postgres';
test('source financial review hold requires complete proof and survives repository readback',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
  await ensureRentOpsSchema({apply:true,query:(sql)=>db.query(sql),executor:async(sql)=>{await db.exec(sql)}});
  await db.query("INSERT INTO rent_ops_people(id,first_name,last_name,payment_review_reason,payment_review_artifact_sha256,payment_review_source_reference) VALUES($1,$2,$3,$4,$5,$6)",['person-review','Synthetic','Resident','assistance_responsibility_unverified','a'.repeat(64),'source:tenant:review-record']);
  await db.exec('CREATE ROLE hold_runtime; GRANT USAGE ON SCHEMA public TO hold_runtime; GRANT SELECT ON '+RENT_OPS_RUNTIME_REQUIRED_TABLES.join(',')+' TO hold_runtime; SET ROLE hold_runtime');
  const repository=new PostgresRentOpsRepository({query:(sql,params)=>db.query(sql,params)});
  const person=(await repository.getSnapshot()).people.find(p=>p.id==='person-review');
  assert.equal(person?.paymentReviewReason,'assistance_responsibility_unverified');assert.equal(person?.paymentReviewArtifactSha256,'a'.repeat(64));assert.equal(person?.paymentReviewSourceReference,'source:tenant:review-record');
  await db.exec('RESET ROLE');
  for(const [reason,digest,reference] of [[null,'a'.repeat(64),'source'],['assistance_responsibility_unverified',null,'source'],['assistance_responsibility_unverified','a'.repeat(64),null],['assistance_responsibility_unverified','bad','source'],['invented','a'.repeat(64),'source']]){
   await assert.rejects(db.query('INSERT INTO rent_ops_people(id,payment_review_reason,payment_review_artifact_sha256,payment_review_source_reference) VALUES($1,$2,$3,$4)',['invalid',reason,digest,reference]));
  }
  await db.query("INSERT INTO rent_ops_people(id) VALUES('unreviewed')");
 }finally{await db.close()}
});
