import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeOperationalScheduleRegister, loadOperationalScheduleRegister } from '../api';
import type { AdminRecurringScheduleView, OperationalScheduleRegister } from '../types';
import { recurringRegisterQueryKey, selectRecurringRegisterRows } from './recurring-register-model';

const metadata: OperationalScheduleRegister = { asOfDate:'2026-09-12',currentScheduleIds:['current'],historicalScheduleIds:['former'],futureScheduleIds:['future'],unitDefaultScheduleIds:['current'],propertyDefaultScheduleIds:['property-default'],reviewScheduleIds:['uncertain'],complete:false };
const rows: AdminRecurringScheduleView[] = ['current','former','future','property-default','uncertain','unclassified'].map(id=>({id,active:true,effectiveFrom:'2026-01-01',effectiveTo:null,lineageState:'valid',canScheduleSuccessor:true}));

test('global recurring defaults and partitions use server selection despite open source dates',()=>{
 assert.deepEqual(selectRecurringRegisterRows(rows,metadata,'current').map(row=>row.id),['current']);
 assert.deepEqual(selectRecurringRegisterRows(rows,metadata,'history').map(row=>row.id),['former']);
 assert.deepEqual(selectRecurringRegisterRows(rows,metadata,'future').map(row=>row.id),['future']);
 assert.deepEqual(selectRecurringRegisterRows(rows,metadata,'unit-default').map(row=>row.id),['current']);
 assert.deepEqual(selectRecurringRegisterRows(rows,metadata,'property-default').map(row=>row.id),['property-default']);
 assert.deepEqual(selectRecurringRegisterRows(rows,metadata,'review').map(row=>row.id),['uncertain','unclassified']);
 assert.equal(selectRecurringRegisterRows(rows,metadata,'all').length,rows.length);
 assert.equal(selectRecurringRegisterRows(rows,metadata,'history')[0].canChange,false);
 assert.equal(selectRecurringRegisterRows(rows,metadata,'future')[0].canChange,false);
 assert.deepEqual(rows.find(row=>row.id==='former')?.effectiveTo,null);
});

test('global recurring strictly decodes metadata and permits overlapping default scope labels',()=>{
 assert.deepEqual(decodeOperationalScheduleRegister(metadata),metadata);
 for(const change of [
  {asOfDate:'2026-02-31'}, {complete:'false'}, {complete:true}, {reviewScheduleIds:null},
  {currentScheduleIds:['current','current']}, {futureScheduleIds:['current']},
  {historicalScheduleIds:['bad/id']}, {ownerNotes:'private'}, {unitDefaultScheduleIds:undefined},
 ]) assert.throws(()=>decodeOperationalScheduleRegister({...metadata,...change}));
});

test('register cache keys isolate identity, property scope, property and reporting date',()=>{
 const base=recurringRegisterQueryKey('user-1','active','all','2026-09-12');
 for(const key of [recurringRegisterQueryKey('user-2','active','all','2026-09-12'),recurringRegisterQueryKey('user-1','all','all','2026-09-12'),recurringRegisterQueryKey('user-1','active','property-1','2026-09-12'),recurringRegisterQueryKey('user-1','active','all','2026-10-01')]) assert.notDeepEqual(key,base);
});

test('register transport includes session credentials and forwards filter cancellation',async()=>{
 const original=globalThis.fetch;
 const controller=new AbortController();
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input),'http://localhost');
  assert.equal(url.pathname,'/api/rent-ops/workspace/recurring');
  assert.equal(url.searchParams.get('propertyId'),'property-1');
  assert.equal(url.searchParams.get('asOfDate'),'2026-09-12');
  assert.equal(init?.credentials,'include');
  assert.equal(init?.signal,controller.signal);
  return new Response(JSON.stringify(metadata),{status:200});
 };
 try{
  assert.deepEqual(await loadOperationalScheduleRegister({propertyId:'property-1',asOfDate:'2026-09-12'},controller.signal),metadata);
  globalThis.fetch=async(_input,init)=>{
   assert.equal(init?.signal,controller.signal);
   throw new DOMException('Aborted','AbortError');
  };
  controller.abort();
  await assert.rejects(loadOperationalScheduleRegister({asOfDate:'2026-09-12'},controller.signal),{name:'AbortError'});
 }finally{globalThis.fetch=original;}
});
