import {rentOpsMigrationDefinitions} from '../server/rent-ops/persistence';
import test from 'node:test';import assert from 'node:assert/strict';import {exportSourceIdentityCrosswalk} from './export-provisioning-crosswalk';
test('historical crosswalk export stays read-only and stops before identity reads on the expanded release',async()=>{
 let selected=0;
 await assert.rejects(()=>exportSourceIdentityCrosswalk({
  query:async()=>{throw Error('pool query forbidden');},
  transaction:async(work,options)=>{
   assert.equal(options?.readOnly,true);
   return work({query:async(sql)=>{
    assert.match(sql,/^SELECT version,checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version$/);
    assert.doesNotMatch(sql,/raw_metadata|email|password|token|rent_ops_source_records/i);
    selected++;
    return {rows:rentOpsMigrationDefinitions().map(row=>({version:row.version,checksum_sha256:row.checksum}))};
   }});
  },
 }),/Local provisioning release differs/);
 assert.equal(selected,1);
});
test('target fingerprint omits credentials but binds the database endpoint',async()=>{const {provisionTargetFingerprint}=await import('./export-provisioning-crosswalk');assert.equal(provisionTargetFingerprint('postgres://auditor:one@ep-example-pooler.region.neon.tech/db'),provisionTargetFingerprint('postgres://web:two@ep-example.region.neon.tech/db'));assert.notEqual(provisionTargetFingerprint('postgres://web:two@ep-example.region.neon.tech/db'),provisionTargetFingerprint('postgres://web:two@ep-other.region.neon.tech/db'));});
