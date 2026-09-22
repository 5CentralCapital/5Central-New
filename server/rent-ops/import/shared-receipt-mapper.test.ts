import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRentManagerExport } from '../export/normalizer';
import { mapRentManagerExport } from './rm-mapper';

function source() {
 const raw = {
 properties:[{PropertyID:1,Name:'First'},{PropertyID:2,Name:'Second'}],
 units:[{UnitID:11,PropertyID:1,Name:'A'},{UnitID:22,PropertyID:2,Name:'B'}],
 tenants:[{TenantID:7,Name:'Shared Account'},{TenantID:8,Name:'Other Account'}],
 leases:[{LeaseID:51,TenantID:7,PropertyID:1,UnitID:11,Status:'Past'},{LeaseID:52,TenantID:7,PropertyID:2,UnitID:22,Status:'Current'}],
 charges:[{LeaseID:51,ChargeID:101,AccountID:7,PropertyID:1,UnitID:11,Amount:60,TransactionDate:'2026-07-01'}, {LeaseID:52,ChargeID:102,AccountID:7,PropertyID:2,UnitID:22,Amount:40,TransactionDate:'2026-07-01'}],
 payments:[{PaymentID:201,AccountID:7,PrepayPropertyID:1,PrepayUnitID:11,Amount:100,TransactionDate:'2026-07-30'}],
 allocations:[{AllocationID:301,PaymentID:201,ChargeID:101,PropertyID:1,UnitID:11,Amount:60,AllocationDate:'2026-08-02'}, {AllocationID:302,PaymentID:201,ChargeID:102,PropertyID:2,UnitID:22,Amount:40,AllocationDate:'2026-08-05'}],
 };
 return {...raw, payments: raw.payments.map(payment=>({...payment,Allocations:raw.allocations}))};
}
const options = {fidelityVersion:3 as const,artifactSha256:'a'.repeat(64),artifactObservationOn:'2026-08-06'};

test('v3 source shape preserves one shared receipt and exact lagged property applications',()=>{
 const normalized=normalizeRentManagerExport(source());
 assert.equal(normalized.exceptions.some(row=>row.detail==='payment_allocated_charges_span_multiple_properties'),false);
 const first=mapRentManagerExport(normalized.input,options);
 const second=mapRentManagerExport(normalized.input,options);
 assert.equal(first.exceptions.some(row=>row.code==='shared_payment_scope_unresolved'),false);
 const payments=first.snapshot.ledgerTransactions.filter(row=>row.kind==='payment');
 assert.equal(payments.length,1);
 const root=payments[0];
 assert.equal(root.amountCents,10000); assert.equal(root.postedOn,'2026-07-30');
 assert.equal(root.allocationMode,'multi_property');
 assert.equal(root.propertyId,null); assert.equal(root.unitId,null);assert.equal(root.tenancyId,null);
 assert.equal(root.personLinkKnowledge,'exact');assert.ok(root.personId);
 assert.equal(first.snapshot.paymentAllocations.length,2);
 assert.deepEqual(first.snapshot.paymentAllocations.map(row=>row.allocatedOn),['2026-08-02','2026-08-05']);
 assert.equal(first.snapshot.paymentAllocations.reduce((sum,row)=>sum+(row.amountCents??0),0),10000);
 assert.ok(first.snapshot.ledgerTransactions.filter(row=>row.kind==='charge').every(row=>row.propertyId&&row.unitId&&row.tenancyId));
 assert.ok(first.snapshot.paymentAllocations.every(row=>row.paymentTransactionId===root.id&&row.chargeLinkKnowledge==='exact'));
 assert.equal(second.snapshot.ledgerTransactions.find(row=>row.kind==='payment')?.id,root.id);
});

test('shared source relationship rejects mismatched account and incomplete amount tie-out',()=>{
 for(const failure of ['person','total']) {
  const raw=source();
  if(failure==='person') raw.charges[1].AccountID=8;
  else { raw.allocations[1].Amount=39; raw.payments[0].Allocations[1].Amount=39; }
  const normalized=normalizeRentManagerExport(raw);
  assert.ok(normalized.exceptions.some(row=>row.detail==='payment_allocated_charges_span_multiple_properties'),JSON.stringify({failure,charges:normalized.input.charges,exceptions:normalized.exceptions}));
  const mapped=mapRentManagerExport(normalized.input,options);
  assert.ok(mapped.exceptions.some(row=>row.code==='shared_payment_scope_unresolved'&&row.severity==='error'),failure);
 }
});
