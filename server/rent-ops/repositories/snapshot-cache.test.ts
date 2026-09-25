import assert from 'node:assert/strict';
import test from 'node:test';
import {SnapshotReadCache} from './snapshot-cache';

test('concurrent readers share a decoded immutable snapshot and expiration refreshes it', async () => {
  let now=0, reads=0;
  const cache=new SnapshotReadCache<{rows:{amount:number}[]}>(()=>1,()=>now,2000);
  const load=async()=>{reads++; return {rows:[{amount:100}]};};
  const values=await Promise.all(Array.from({length:10},()=>cache.read('report',load)));
  assert.equal(reads,1);
  assert.ok(values.every(value=>value===values[0]));
  assert.throws(()=>{values[0].rows[0].amount=200;},TypeError);
  now=2001;
  await cache.read('report',load);
  assert.equal(reads,2);
});

test('writes invalidate prior and in-flight snapshots and never share uncommitted reads', async () => {
  let generation:number|undefined=0, reads=0;
  let release!: (value:{balance:number})=>void;
  const cache=new SnapshotReadCache<{balance:number}>(()=>generation);
  const pending=cache.read('report',()=>new Promise(done=>{release=done;}));
  generation=1;
  release({balance:10});
  await pending;
  const load=async()=>{reads++; return {balance:20};};
  assert.equal((await cache.read('report',load)).balance,20);
  assert.equal(reads,1);
  generation=undefined;
  await Promise.all([cache.read('report',load),cache.read('report',load)]);
  assert.equal(reads,3);
  generation=2;
  await cache.read('report',load);
  assert.equal(reads,4);
});

test('cache holds one read projection and failed reads can recover', async () => {
  let reads=0;
  const cache=new SnapshotReadCache<object>(()=>0);
  const load=async()=>{reads++; return {};};
  await cache.read('report',load);
  await cache.read('operational',load);
  await cache.read('report',load);
  assert.equal(reads,3);
  await assert.rejects(cache.read('failed',async()=>{throw Error('unavailable');}));
  await cache.read('failed',load);
  assert.equal(reads,4);
});
