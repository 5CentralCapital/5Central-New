import assert from 'node:assert/strict';
import test from 'node:test';
import { isIsoDate, isoDateSchema } from '../../../shared/rent-ops-contracts';

test('fast date predicate accepts exactly the existing API date schema',()=>{
  const values:unknown[]=[null,undefined,false,20260912,{},[],new Date(),'','2026-9-1','2026-09-12T00:00:00Z',' 2026-09-12','0000-01-01','0099-12-31','10000-01-01'];
  for(const year of [0,1,99,100,1900,1999,2000,2024,2025,2026,2100,2400,9999])
    for(let month=0;month<=13;month++)for(let day=0;day<=32;day++)values.push(`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
  for(const value of values)assert.equal(isIsoDate(value),isoDateSchema.safeParse(value).success,String(value));
});
