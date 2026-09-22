import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticRentOpsRepository } from "../fixtures/synthetic";
import { RentOpsService } from "./service";
import type { ManualPaymentInput } from "./operational-inputs";
const context = {actorSubject:"qa-admin",occurredAt:"2026-09-08T12:00:00Z"};
const payment: ManualPaymentInput = {id:"qa-manual-payment",tenancyId:"demo-tenancy-1",amountCents:1000,postedOn:"2026-09-08",paymentMethod:"cash",description:"QA manual receipt",category:"base_rent",allocations:[]};

test("manual payment identical concurrent replay creates one receipt; conflicting replay preserves it", async () => {
  const repo = createSyntheticRentOpsRepository(); const service = new RentOpsService(repo);
  const results = await Promise.all([service.recordManualPayment(payment,context),service.recordManualPayment(payment,context)]);
  assert.equal(results.filter(row=>row.replayed).length,1);
  assert.equal((await repo.getSnapshot()).ledgerTransactions.filter(row=>row.id===payment.id).length,1);
  await assert.rejects(service.recordManualPayment({...payment,amountCents:2000},context),/conflicts/);
});

test("manual payment rejects scope errors, invalid dates, deposit allocations and atomic over-allocation",async()=>{
 const repo=createSyntheticRentOpsRepository(); const service=new RentOpsService(repo); const before=await repo.getSnapshot();
 for(const input of [{...payment,tenancyId:"missing"},{...payment,postedOn:"2026-02-30"},{...payment,category:"security_deposit"},{...payment,allocations:[{chargeTransactionId:"demo-charge-rent-3",amountCents:1000}]}]) await assert.rejects(service.recordManualPayment(input as ManualPaymentInput,context));
 await assert.rejects(service.recordManualPayment({...payment,amountCents:900000,allocations:[{chargeTransactionId:"demo-charge-fee-1",amountCents:900000}]},context));
 assert.deepEqual((await repo.getSnapshot()).ledgerTransactions,before.ledgerTransactions);
});

test("charge definition supports revision-protected labels and active state while category stays immutable",async()=>{
 const repo=createSyntheticRentOpsRepository();const service=new RentOpsService(repo);
 const created=await service.createChargeDefinition({id:"qa-water",displayName:"Water",category:"recurring_fee",active:true},context);
 assert.equal(created.recordRevision,1);
 const attempts=await Promise.allSettled([service.patchChargeDefinition(created.id,1,{displayName:"Water bill"},context),service.patchChargeDefinition(created.id,1,{active:false},context)]);
 assert.equal(attempts.filter(row=>row.status==="fulfilled").length,1);
 await assert.rejects(service.patchChargeDefinition(created.id,2,{category:"base_rent"} as any,context));
 assert.equal((await repo.getSnapshot()).chargeDefinitions.find(row=>row.id===created.id)?.category,"recurring_fee");
});
