import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { TenantAccountAdminService } from "./admin-service";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { PostgresTenantAccountStore } from "./store";

test("audited account changes commit together, reject stale revisions, and roll back on audit failure",async()=>{
 const db=new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql);}});
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES('p','p');INSERT INTO rent_ops_units(id,property_id,property_link_knowledge)VALUES('u','p','manual');INSERT INTO rent_ops_people(id)VALUES('person');INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');`);
  const store=new PostgresTenantAccountStore(db);
  const base={id:"qa-account",actorSubject:"verified-manager",now:"2026-09-08T00:00:00Z"};
  const created=(await store.auditedMutation({...base,action:"grant",email:"qa@example.test",personId:"person",tenancyId:"t",tokenHash:"a".repeat(64),expiresAt:"2026-09-09T00:00:00Z"}))!;
  assert.equal(created.sessionVersion,1);
  assert.equal((await db.query("SELECT * FROM rent_ops_activity_events")).rows.length,1);
  assert.equal(await store.auditedMutation({...base,action:"revoke",expectedCredentialRevision:2}),undefined);
  assert.equal((await store.getById(base.id))!.status,"pending");
  await db.exec("ALTER TABLE rent_ops_activity_events ADD CONSTRAINT synthetic_reject_audit CHECK (actor <> 'reject-audit')");
  await assert.rejects(store.auditedMutation({...base,action:"revoke",expectedCredentialRevision:1,actorSubject:"reject-audit"}));
  assert.equal((await store.getById(base.id))!.sessionVersion,1);
  assert.equal((await store.getById(base.id))!.status,"pending");
  const revoked=(await store.auditedMutation({...base,action:"revoke",expectedCredentialRevision:1}))!;
  assert.equal(revoked.status,"revoked");assert.equal(revoked.sessionVersion,2);
  const audits=(await db.query<{actor:string;metadata:unknown}>("SELECT actor,metadata FROM rent_ops_activity_events")).rows;
  assert.equal(audits.length,2);assert.ok(audits.every(row=>row.actor==="verified-manager"));
  assert.doesNotMatch(JSON.stringify(audits),/activation|password|tokenHash|aaaaaaaa/);
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES('demo-property-a','demo-a');INSERT INTO rent_ops_units(id,property_id,property_link_knowledge)VALUES('demo-unit-a-1','demo-property-a','manual');INSERT INTO rent_ops_people(id)VALUES('demo-person-1');INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)VALUES('demo-tenancy-1','demo-property-a','demo-unit-a-1','demo-person-1','current',NOW(),'manual','manual','manual','manual');`);
  let deliveries=0;let fail=false;
  const service=new TenantAccountAdminService({store,repository:new SyntheticRentOpsRepository(syntheticRentOpsSnapshot()),now:()=>new Date(base.now),notifier:async()=>{deliveries++;if(fail)throw new Error("response lost");}});
  const context={actorSubject:"verified-manager"};
  const grantInput={requestId:"request-one",email:"qa2@example.test",personId:"demo-person-1",tenancyId:"demo-tenancy-1"};
  const granted=await service.grantForMcp(grantInput,context);
  assert.deepEqual(await service.grantForMcp(grantInput,context),granted);
  await assert.rejects(service.grantForMcp({...grantInput,email:"other@example.test"},context),/already belongs/);
  assert.doesNotMatch(JSON.stringify(granted),/activationPath|token|passwordHash/);
  assert.equal(deliveries,0);
  const beforeIssue=(await store.getById(granted.account.id))!.activationTokenHash;
  await assert.rejects(store.issueAuditedDelivery({commandId:"rejected-command",accountId:granted.account.id,actorSubject:"reject-audit",tokenHash:"b".repeat(64),expiresAt:"2026-09-09T00:00:00Z",now:base.now}));
  assert.equal((await store.getById(granted.account.id))!.activationTokenHash,beforeIssue);
  const sent=await service.sendLinkForMcp(granted.account.id,"delivery-one",context);
  assert.equal(sent.delivery,"accepted");assert.equal(deliveries,1);
  assert.deepEqual(await service.sendLinkForMcp(granted.account.id,"delivery-one",context),{delivery:"accepted",replayed:true});
  assert.equal(deliveries,1);
  fail=true;
  assert.equal((await service.sendLinkForMcp(granted.account.id,"delivery-two",context)).delivery,"indeterminate");
  assert.equal((await service.sendLinkForMcp(granted.account.id,"delivery-two",context)).delivery,"indeterminate");
  assert.equal(deliveries,2);assert.equal((await store.getById(granted.account.id))!.activationTokenHash,null);
  const reissued=await service.reissueForMcp(granted.account.id,granted.account.credentialRevision,context);
  assert.equal(reissued.account.credentialRevision,2);
  await assert.rejects(service.revokeForMcp(granted.account.id,1,context),/changed/);
  assert.equal((await service.revokeForMcp(granted.account.id,2,context)).account.status,"revoked");

 } finally {await db.close();}
});
