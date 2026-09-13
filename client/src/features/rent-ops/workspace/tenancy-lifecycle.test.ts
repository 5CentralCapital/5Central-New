import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleEligible, lifecyclePatch } from './tenancy-lifecycle';
import type { AdminTenancyView } from '../types';
const future = { id:'t', propertyId:'p', unitId:'u', primaryPersonId:'person', recordRevision:3, status:'future' } as AdminTenancyView;
test('actual move-in patches only existing tenancy and date; notice does not end occupancy', () => {
 assert.deepEqual(lifecyclePatch(future,'move-in','2026-09-12','2026-09-12'),{id:'t',revision:3,status:'current',actualMoveInOn:'2026-09-12'});
 assert.deepEqual(lifecyclePatch({...future,status:'current',actualMoveInOn:'2026-01-01'},'notice','2026-09-12','2026-09-12','2026-10-01'),{id:'t',revision:3,status:'notice',noticeOn:'2026-09-12',expectedMoveOutOn:'2026-10-01'});
 assert.deepEqual(lifecyclePatch({...future,status:'notice',actualMoveInOn:'2026-01-01'},'move-out','2026-09-12','2026-09-12'),{id:'t',revision:3,status:'past',actualMoveOutOn:'2026-09-12'});
});
test('invalid/future actual events, ended tenancies and missing revisions cannot be submitted',()=>{
 for (const date of ['2026-09-13','2026-02-30','']) assert.throws(()=>lifecyclePatch(future,'move-in',date,'2026-09-12'));
 assert.throws(()=>lifecyclePatch({...future,recordRevision:undefined},'move-in','2026-09-12','2026-09-12'));
 assert.throws(()=>lifecyclePatch({...future,status:'past'},'move-out','2026-09-12','2026-09-12'));
 assert.throws(()=>lifecyclePatch({...future,status:'current',actualMoveInOn:'2026-09-10'},'move-out','2026-09-09','2026-09-12'));
});

test('retired current source tenancy is excluded while observed replacement remains eligible',()=>{
 const old={...future,status:'current',actualMoveInOn:'2024-11-01',actualMoveInKnowledge:'source',operationalEndConfirmedOn:'2026-09-12',operationalEndConfirmationKnowledge:'manual'};
 const replacement={...future,id:'replacement',status:'current',occupancyConfirmedOn:'2026-09-12',occupancyConfirmationKnowledge:'manual',actualMoveInKnowledge:'unknown'};
 for(const mode of ['notice','move-out'] as const){assert.equal(lifecycleEligible(old,mode,'2026-09-12'),false);assert.equal(lifecycleEligible(replacement,mode,'2026-09-12'),true);assert.throws(()=>lifecyclePatch(old,mode,'2026-09-12','2026-09-12','2026-10-01'),/not eligible/);}
});
