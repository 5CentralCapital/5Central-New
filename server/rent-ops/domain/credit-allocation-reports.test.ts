import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { deriveTenantLedger, deriveCollectedIncome } from './reports';

function fixture() {
 const snapshot=syntheticRentOpsSnapshot();
 const charge=snapshot.ledgerTransactions.find(row=>row.kind==='charge'&&row.category==='base_rent')!;
 snapshot.ledgerTransactions=[{...charge,id:'charge',amountCents:10000,postedOn:'2026-08-01'}, {...charge,id:'credit',kind:'credit',amountCents:4000,postedOn:'2026-08-02'}];
 snapshot.paymentAllocations=[{id:'application',kind:'credit_allocation',paymentTransactionId:null,creditTransactionId:'credit',chargeTransactionId:'charge',amountCents:3000,allocatedOn:'2026-08-05',creditLinkKnowledge:'exact',chargeLinkKnowledge:'exact'}];
 return {snapshot,tenancyId:charge.tenancyId!};
}
test('credit application reduces charge only when applied and never counts credit twice or as collected cash',()=>{
 const {snapshot,tenancyId}=fixture();
 const original=structuredClone(snapshot);
 const before=deriveTenantLedger(snapshot,tenancyId,{asOfDate:'2026-08-04'});
 assert.equal(before[0].openCents,10000);assert.equal(before[1].openCents,-4000);assert.equal(before.at(-1)?.runningBalanceCents,6000);
 const after=deriveTenantLedger(snapshot,tenancyId,{asOfDate:'2026-08-06'});
 assert.equal(after.length,2);assert.equal(after[0].openCents,7000);assert.equal(after[1].openCents,-1000);assert.equal(after[1].allocatedCents,3000);assert.equal(after.at(-1)?.runningBalanceCents,6000);
 for(const modelVersion of [2,3] as const){snapshot.modelVersion=modelVersion;assert.deepEqual(deriveCollectedIncome(snapshot,{month:'2026-08',asOfDate:'2026-08-06'}),[]);}
 snapshot.modelVersion=original.modelVersion;assert.deepEqual(snapshot,original);
});
test('unresolved links and negative credit applications keep derived balances unavailable',()=>{
 for(const invalid of ['link','negative'] as const){
  const {snapshot,tenancyId}=fixture();
  if(invalid==='link')snapshot.paymentAllocations[0].creditLinkKnowledge='unknown';else snapshot.paymentAllocations[0].amountCents=-3000;
  const row=deriveTenantLedger(snapshot,tenancyId,{asOfDate:'2026-08-06'})[0]; assert.equal(row.openCents,null); assert.equal(row.transaction.amountCents,10000); assert.equal(row.balanceComplete,false);
 }
});
test('reversed credit reopens its applied charge without inferred negative allocations',()=>{
 const {snapshot,tenancyId}=fixture();
 snapshot.ledgerTransactions.push({...snapshot.ledgerTransactions[1],id:'reverse-credit',kind:'reversal',reversalOfId:'credit',postedOn:'2026-08-07'});
 const rows=deriveTenantLedger(snapshot,tenancyId,{asOfDate:'2026-08-08'});
 assert.equal(rows[0].openCents,10000);assert.equal(rows.at(-1)?.runningBalanceCents,10000);
});
test('account-scoped credit updates charge open without inventing a scoped credit root',()=>{
 const {snapshot,tenancyId}=fixture();snapshot.ledgerTransactions[1].tenancyId=null;
 const rows=deriveTenantLedger(snapshot,tenancyId,{asOfDate:'2026-08-06'});
 assert.equal(rows.length,1);assert.equal(rows[0].openCents,7000);
 assert.equal(snapshot.ledgerTransactions.filter(row=>row.kind==='credit').length,1);
});
