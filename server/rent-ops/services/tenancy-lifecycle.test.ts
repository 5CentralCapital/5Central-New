import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticRentOpsRepository } from '../fixtures/synthetic';
import { RentOpsService } from './service';
const context={actorSubject:'test-admin',occurredAt:'2026-09-12T12:00:00Z'};
test('actual move-out retains all financial history and rejects stale duplicate write',async()=>{
 const repository=createSyntheticRentOpsRepository();const service=new RentOpsService(repository,()=>new Date(context.occurredAt));
 const before=await repository.getSnapshot();const tenancy=before.tenancies.find(row=>row.id==='demo-tenancy-1')!;
 await service.patchRecord('tenancy',tenancy.id,tenancy.recordRevision??1,{status:'past',actualMoveOutOn:'2026-09-12'},context);
 const after=await repository.getSnapshot();
 assert.equal(after.tenancies.find(row=>row.id===tenancy.id)?.actualMoveOutOn,'2026-09-12');
 assert.deepEqual(after.ledgerTransactions,before.ledgerTransactions);assert.deepEqual(after.recurringSchedules,before.recurringSchedules);assert.deepEqual(after.securityDeposits,before.securityDeposits);
 await assert.rejects(()=>service.patchRecord('tenancy',tenancy.id,tenancy.recordRevision??1,{status:'past',actualMoveOutOn:'2026-09-12'},context),/stale/);
});
test('future actual dates fail without completing the move; planned notice is permitted',async()=>{
 const repository=createSyntheticRentOpsRepository();const service=new RentOpsService(repository,()=>new Date(context.occurredAt));
 await assert.rejects(()=>service.patchRecord('tenancy','demo-tenancy-1',1,{status:'past',actualMoveOutOn:'2026-10-01'},context),/Actual move dates/);
 assert.equal((await repository.getSnapshot()).tenancies.find(row=>row.id==='demo-tenancy-1')?.actualMoveOutOn,undefined);
 await service.patchRecord('tenancy','demo-tenancy-1',1,{status:'notice',noticeOn:'2026-09-12',expectedMoveOutOn:'2026-10-01'},context);
 assert.equal((await repository.getSnapshot()).tenancies.find(row=>row.id==='demo-tenancy-1')?.status,'notice');
});

test('moving in an existing future tenancy preserves identity; occupied-unit conflict cannot complete',async()=>{
 const repository=createSyntheticRentOpsRepository();const service=new RentOpsService(repository,()=>new Date(context.occurredAt));
 const before=await repository.getSnapshot();const source=before.tenancies.find(row=>row.id==='demo-tenancy-2')!;
 await repository.saveTenancy({...source,actualMoveInOn:undefined,plannedMoveInOn:'2026-09-12',recordRevision:1});
 const moved=await service.patchRecord('tenancy',source.id,1,{status:'current',actualMoveInOn:'2026-09-12'},context) as typeof source;
 assert.equal(moved.id,source.id);assert.equal(moved.unitId,source.unitId);assert.equal((await repository.getSnapshot()).tenancies.length,before.tenancies.length);
 const clone={...source,id:'future-conflict',unitId:'demo-unit-a-1',actualMoveInOn:undefined,plannedMoveInOn:'2026-09-12',recordRevision:1};
 await repository.saveTenancy(clone);
 await assert.rejects(()=>service.patchRecord('tenancy',clone.id,1,{status:'current',actualMoveInOn:'2026-09-12'},context),/invariant|sibling/i);
 assert.equal((await repository.getSnapshot()).tenancies.find(row=>row.id===clone.id)?.status,'future');
 assert.equal((await repository.getSnapshot()).tenancies.find(row=>row.id===clone.id)?.actualMoveInOn,undefined);
});

test('operationally retired source tenancy cannot be reopened or receive a move event',async()=>{
 const repository=createSyntheticRentOpsRepository();const service=new RentOpsService(repository,()=>new Date(context.occurredAt));
 const original=(await repository.getSnapshot()).tenancies.find(row=>row.id==='demo-tenancy-1')!;
 await repository.saveTenancy({...original,operationalEndConfirmedOn:'2026-09-12',operationalEndConfirmationKnowledge:'manual'});
 for (const patch of [{status:'notice',noticeOn:'2026-09-12',expectedMoveOutOn:'2026-10-01'},{status:'past',actualMoveOutOn:'2026-09-12'},{status:'current',actualMoveInOn:'2026-09-12'}]) await assert.rejects(()=>service.patchRecord('tenancy',original.id,original.recordRevision??1,patch,context),/Operationally ended/);
 assert.equal((await repository.getSnapshot()).tenancies.find(row=>row.id===original.id)?.actualMoveOutOn,undefined);
});
