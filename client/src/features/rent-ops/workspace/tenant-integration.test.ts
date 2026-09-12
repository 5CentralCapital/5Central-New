import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoAdminSnapshot } from '../demo';
import { buildLedgerRows, classifyRecurringSchedule, resolveTenantBalance, isCurrentTenancy } from './tenant-model';

test('tenant balance cannot use another resident delinquency row merely because property matches',()=>{
  const snapshot=createDemoAdminSnapshot();
  const tenant=structuredClone(snapshot.tenants[0]);
  tenant.ledger=[];
  snapshot.delinquency=[{personId:'other-person',tenancyId:'other-tenancy',propertyId:tenant.tenancy!.propertyId,totalBalanceCents:987600,balanceComplete:true}];
  const balance=resolveTenantBalance(tenant,snapshot);
  assert.equal(balance.amountCents,null);
  assert.equal(balance.source,'unavailable');
});

test('incomplete ledger rows cannot present supplied numeric running balances as confirmed',()=>{
  const snapshot=createDemoAdminSnapshot();
  const tenant=structuredClone(snapshot.tenants[0]);
  tenant.ledger=[{transaction:{id:'incomplete-charge',kind:'charge',status:'posted',amountCents:1000,postedOn:'2026-08-15'},runningBalanceCents:1000,allocatedCents:0,openCents:1000,balanceComplete:false,balanceUncertaintyCodes:['allocation_evidence_unknown']}];
  assert.equal(buildLedgerRows(tenant,snapshot)[0].runningBalanceCents,null);
});

test('unknown schedule activation cannot be categorized as confirmed current',()=>{
  assert.equal(classifyRecurringSchedule({id:'unknown-active',effectiveFrom:'2026-08-01',active:null,amountCents:1000,billingFrequency:null},'2026-08-15'),'unknown');
});

test('actual move-out is exclusive but cancelled tenancy cannot be resurrected by old move-in date',()=>{
  assert.equal(isCurrentTenancy({id:'moved-out',status:'current',actualMoveInOn:'2026-08-01',actualMoveOutOn:'2026-08-15'},'2026-08-15'),false);
  assert.equal(isCurrentTenancy({id:'cancelled',status:'cancelled',actualMoveInOn:'2026-08-01'},'2026-08-15'),false);
});
