import assert from 'node:assert/strict';
import test from 'node:test';
import {syntheticRentOpsSnapshot} from '../fixtures/synthetic';
import {verifyImportedFinancialControls} from './financial-readiness-controls';
test('operator controls require exact source account, balance and payment hold semantics',()=>{
 const snapshot=structuredClone(syntheticRentOpsSnapshot());const tenancy=snapshot.tenancies[0];snapshot.tenancies=[tenancy];snapshot.subsidyContracts=[];snapshot.paymentAllocations=[];
 const person=snapshot.people.find(p=>p.id===tenancy.primaryPersonId)!;person.source={system:'rent_manager',entityType:'person',sourceId:'123'};
 snapshot.ledgerTransactions=[{id:'rent',propertyId:tenancy.propertyId,unitId:tenancy.unitId,tenancyId:tenancy.id,personId:person.id,kind:'charge',category:'base_rent',status:'posted',amountCents:10000,postedOn:'2026-09-01',description:'Synthetic rent'}];
 const control={asOfDate:'2026-09-07',accounts:[{sourceTenantId:'123',balanceCents:10000,expectedPaymentReason:null,expectedPayableCents:10000}]};
 assert.equal(verifyImportedFinancialControls(snapshot,control).balanceCents,10000);
 for(const change of [{sourceTenantId:'124'},{balanceCents:9999},{expectedPayableCents:9999},{expectedPaymentReason:'assistance_responsibility_unverified'}])assert.throws(()=>verifyImportedFinancialControls(snapshot,{...control,accounts:[{...control.accounts[0],...change}]}));
 assert.throws(()=>verifyImportedFinancialControls(snapshot,{...control,accounts:[...control.accounts,...control.accounts]}));
 snapshot.ledgerTransactions[0].status=null;assert.throws(()=>verifyImportedFinancialControls(snapshot,control));
});
