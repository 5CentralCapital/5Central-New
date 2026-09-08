import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TenantAccountAdminService } from "./admin-service";
import { InMemoryTenantAccountStore } from "./test-store";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { createTenantAccessNotifier } from "./delivery";

test("shared account service keeps grants email-free and blocked recovery preserves credentials",async()=>{
 const store=new InMemoryTenantAccountStore();let calls=0;
 const notifier=createTenantAccessNotifier({RENT_OPS_TENANT_EMAIL_ENABLED:"true",RENT_OPS_EMAIL_ALLOWED_RECIPIENTS:"qa@example.test",RENT_OPS_MAGIC_LINK_WEBHOOK_URL:"https://mail.example.test",RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET:"synthetic-secret-1234",RENT_OPS_PUBLIC_APP_URL:"https://portal.example.test"},async()=>{calls++;return new Response(null,{status:202});});
 const service=new TenantAccountAdminService({repository:new SyntheticRentOpsRepository(syntheticRentOpsSnapshot()),store,notifier,now:()=>new Date("2026-09-08T00:00:00Z")});
 await assert.rejects(service.grant({email:"resident@example.test",personId:"wrong",tenancyId:"demo-tenancy-1"}));
 assert.equal((await store.list()).length,0);
 const granted=await service.grant({email:"resident@example.test",personId:"demo-person-1",tenancyId:"demo-tenancy-1"});
 assert.equal(calls,0);
 const token=granted.activationPath.split("#activate=")[1];
 const active=(await store.consumeActivation(createHash("sha256").update(token).digest("hex"),"working-password-hash","2026-09-08T00:00:00Z"))!;
 await assert.rejects(service.sendLink(active.id),/could not be confirmed/);
 assert.equal(calls,0);
 const unchanged=(await store.getById(active.id))!;
 assert.equal(unchanged.passwordHash,active.passwordHash);assert.equal(unchanged.sessionVersion,active.sessionVersion);assert.equal(unchanged.activationTokenHash,null);
 const listed=await service.list();
 assert.doesNotMatch(JSON.stringify(listed),/passwordHash|activationTokenHash|working-password-hash/);
 await service.revoke(active.id);
 await assert.rejects(service.sendLink(active.id),/eligible/);
});
