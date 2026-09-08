import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema} from '../server/rent-ops/persistence';
import {validateProvisioningSchema,verifyProvisioningSchema,PROVISIONING_APPROVAL} from './provisioning-schema';
import {exportSourceIdentityCrosswalk,verifiedImportReceiptHash} from './export-provisioning-crosswalk';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
test('provisioning accepts exact installed26 chain and rejects missing, changed, older, newer, duplicate checksums',async()=>{
 const db=new PGlite();try{
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql);}});
  await verifyProvisioningSchema(db);
  const rows=(await db.query<{version:number;checksum_sha256:string}>('SELECT version,checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version')).rows;
  assert.equal(rows.length,26);assert.equal(PROVISIONING_APPROVAL,'two-imports-audited-schema26-approved');
  for(const invalid of [rows.slice(0,25),rows.filter(row=>row.version!==10),[...rows,{version:27,checksum_sha256:'a'.repeat(64)}],[...rows.slice(0,25),rows[24]],rows.map(row=>row.version===26?{...row,checksum_sha256:'b'.repeat(64)}:row),rows.map(row=>row.version===1?{...row,checksum_sha256:''}:row)]) assert.throws(()=>validateProvisioningSchema(invalid),/Exact reviewed/);
  await db.query('UPDATE rent_ops_schema_migrations SET checksum_sha256=$1 WHERE version=26',['c'.repeat(64)]);
  let identityQueries=0;
  await assert.rejects(exportSourceIdentityCrosswalk({query:async()=>{throw Error('pool query forbidden');},transaction:async(work,options)=>{assert.equal(options?.readOnly,true);return work({query:async<T>(sql,args)=>{if(sql.includes('rent_ops_source_records'))identityQueries++;return db.query<T>(sql,args);}});}}),/Exact reviewed/);
  assert.equal(identityQueries,0);
 }finally{await db.close();}
});
test('import evidence remains exact receipt bytes and requires committed plus postcommit audit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'provision-receipt-'));try{
  const path=join(root,'receipt.json');const bytes=JSON.stringify({summary:{committed:true},postcommitAudit:{passed:true}});await writeFile(path,bytes);
  assert.equal(await verifiedImportReceiptHash(path),createHash('sha256').update(bytes).digest('hex'));
  for(const receipt of [{summary:{committed:false},postcommitAudit:{passed:true}},{summary:{committed:true},postcommitAudit:{passed:false}},{summary:{committed:true}}]){await writeFile(path,JSON.stringify(receipt));await assert.rejects(verifiedImportReceiptHash(path),/Committed audited/);}
 }finally{await rm(root,{recursive:true,force:true});}
});
