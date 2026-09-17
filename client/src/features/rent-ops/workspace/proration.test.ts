import test from 'node:test';
import assert from 'node:assert/strict';
import {prorateRent} from './proration';
test('prorates inclusive move-in through actual month end with final cent rounding',()=>{
 assert.deepEqual(prorateRent(149500,'2026-08-21'),{amountCents:53048,days:11,daysInMonth:31,through:'2026-08-31'});
 assert.equal(prorateRent(149500,'2026-08-01').amountCents,149500);
 assert.equal(prorateRent(149500,'2026-08-31').amountCents,4823);
 assert.deepEqual(prorateRent(290000,'2028-02-29'),{amountCents:10000,days:1,daysInMonth:29,through:'2028-02-29'});
 assert.equal(prorateRent(280000,'2026-02-28').amountCents,10000);
 assert.equal(prorateRent(300000,'2026-04-16').amountCents,150000);
 assert.throws(()=>prorateRent(100000,'2026-02-30'));
 assert.throws(()=>prorateRent(0,'2026-08-21'));
 assert.throws(()=>prorateRent(100000,''));
});
