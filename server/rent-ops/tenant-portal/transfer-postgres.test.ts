import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { PostgresTenantAccountStore } from "./store";
import { hashTenantPassword, verifyTenantPassword } from "./passwords";
import { eligibleTenantTenancies, presentTenantHome } from "./presentation";
import { exactPaymentTenancy } from "../payments/model";

const context = { accountId:"existing-account",personId:"resident",oldTenancyId:"old-tenancy",newTenancyId:"new-tenancy",expectedSessionVersion:1,actorSubject:"reviewed-manager",occurredAt:"2026-09-12T12:00:00.000Z",auditId:"portal-transfer-review" };

test("audited same-person portal transfer retains existing credentials and historical bindings atomically", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
    const adapt=(connection:any):RentOpsQueryExecutor=>({query:async(sql,args)=>{
      if(sql.includes("has_table_privilege"))return {rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as any};
      return connection.query(sql,args?.map(value=>value===undefined?null:value));
    },transaction:work=>connection.transaction ? connection.transaction((tx:any)=>work(adapt(tx))) : work(adapt(connection))});
    const executor=adapt(db),repository=new PostgresRentOpsRepository(executor),store=new PostgresTenantAccountStore(executor);
    await db.exec(`INSERT INTO rent_ops_properties(id,name,slug) VALUES('property','Test property','test-property');
      INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('old-unit','property','3','manual'),('new-unit','property','2','manual');
      INSERT INTO rent_ops_people(id,first_name) VALUES('resident','Resident'),('other-person','Other');
      INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,status_knowledge,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,created_at)
      VALUES('old-tenancy','property','old-unit','resident','current','source','manual','manual','manual',NOW()),('new-tenancy','property','new-unit','resident','current','manual','manual','manual','manual',NOW());`);
    await db.exec("UPDATE rent_ops_tenancies SET operational_end_confirmed_on='2026-09-12',operational_end_confirmation_knowledge='manual' WHERE id='old-tenancy'");
    await db.exec("UPDATE rent_ops_tenancies SET occupancy_confirmed_on='2026-09-12',occupancy_confirmation_knowledge='manual' WHERE id='new-tenancy'");
    await db.exec(`INSERT INTO rent_ops_household_memberships(id,tenancy_id,account_person_id,person_id,role) VALUES('old-household','old-tenancy','resident','resident','primary');
      INSERT INTO rent_ops_lease_terms(id,tenancy_id,status,contract_start_on,contract_end_on,created_at) VALUES('old-lease','old-tenancy','expired','2025-01-01','2026-08-31',NOW());
      INSERT INTO rent_ops_documents(id,property_id,unit_id,person_id,tenancy_id,type,state,file_name,mime_type,storage_key) VALUES('old-document','property','old-unit','resident','old-tenancy','lease','archived','Original lease.pdf','application/pdf','documents/private/old-lease');`);
    await repository.saveLedgerTransaction({id:"old-ledger",propertyId:"property",unitId:"old-unit",personId:"resident",tenancyId:"old-tenancy",kind:"charge",category:"base_rent",status:"posted",amountCents:10000,amountKnowledge:"known",postedOn:"2026-08-01",postedOnKnowledge:"manual",dueOn:"2026-08-01",dueOnKnowledge:"manual",description:"Original rent",descriptionKnowledge:"manual",statusKnowledge:"manual",categoryKnowledge:"manual",propertyLinkKnowledge:"manual",unitLinkKnowledge:"manual",personLinkKnowledge:"manual",tenancyLinkKnowledge:"manual",chargeDefinitionId:null,chargeDefinitionLinkKnowledge:"unknown",paymentMethod:null,paymentMethodKnowledge:"unknown",payer:"tenant",payerKnowledge:"manual"});
    assert.equal(await store.auditedMutation({action:"grant",id:"ended-grant",actorSubject:"reviewed-manager",now:context.occurredAt,email:"old-grant@example.test",personId:"resident",tenancyId:"old-tenancy",tokenHash:"b".repeat(64),expiresAt:"2026-10-01T00:00:00Z"}),undefined,"an observed-ended source-current tenancy cannot receive a new grant");
    const passwordHash=await hashTenantPassword("Existing-account-password-123!");
    await db.query(`INSERT INTO rent_ops_tenant_accounts(id,email,person_id,tenancy_id,status,password_hash,activation_token_hash,invitation_expires_at)
      VALUES('existing-account','resident@example.test','resident','old-tenancy','active',$1,$2,'2026-10-01')`,[passwordHash,"a".repeat(64)]);
    const original=(await store.getById(context.accountId))!;
    assert.equal(await verifyTenantPassword("Existing-account-password-123!",original.passwordHash),true);
    await db.query(`INSERT INTO rent_ops_documents(id,property_id,unit_id,person_id,tenancy_id,type,type_knowledge,state,state_knowledge,file_name,mime_type,storage_key,storage_key_knowledge,availability,size_bytes,checksum_sha256,verified_at)
      VALUES('verified-old-lease','property','old-unit','resident','old-tenancy','lease','manual','verified','manual','Verified original lease.pdf','application/pdf',$1,'source','verified',100,$2,'2026-09-01T12:00:00Z')`,['documents/'+"a".repeat(64),"a".repeat(64)]);
    const before=await repository.getSnapshot();
    assert.deepEqual((await repository.readPortalAccountBindings("resident")).map(row=>row.tenancyId),["old-tenancy"]);
    assert.doesNotMatch(JSON.stringify(await repository.readPortalAccountBindings("resident")),/password|token|email/);
    await assert.rejects(()=>db.query("UPDATE rent_ops_tenant_accounts SET tenancy_id='new-tenancy',session_version=2 WHERE id='existing-account'"),/immutable/);
    await assert.rejects(()=>repository.transferPortalAccountBinding(context),/enclosing reconciliation transaction/);
    await assert.rejects(()=>repository.transaction(tx=>tx.transferPortalAccountBinding!({...context,expectedSessionVersion:2})),/changed|ambiguous/);
    await assert.rejects(()=>repository.transaction(tx=>tx.transferPortalAccountBinding!({...context,personId:"other-person"})),/same-person/);
    await assert.rejects(()=>repository.transaction(async tx=>{await tx.transferPortalAccountBinding!(context);throw Error("dry-run rollback");}),/dry-run rollback/);
    assert.deepEqual(await store.getById(context.accountId),original);
    assert.equal((await db.query("SELECT id FROM rent_ops_activity_events WHERE id=$1",[context.auditId])).rows.length,0);
    await repository.transaction(tx=>tx.transferPortalAccountBinding!(context));
    const transferred=(await store.getByEmail(original.email))!;
    assert.equal(transferred.tenancyId,"new-tenancy");
    assert.equal(transferred.sessionVersion,original.sessionVersion+1,"old authenticated session version is invalidated");
    assert.deepEqual({...transferred,tenancyId:original.tenancyId,sessionVersion:original.sessionVersion},original,"password, invitation and access status are preserved");
    assert.equal(await verifyTenantPassword("Existing-account-password-123!",transferred.passwordHash),true,"existing sign-in credentials remain usable");
    const after=await repository.getSnapshot();
    assert.deepEqual(after.ledgerTransactions,before.ledgerTransactions);
    assert.deepEqual(after.documents,before.documents);
    assert.deepEqual(after.leaseTerms,before.leaseTerms);
    assert.deepEqual(after.householdMemberships,before.householdMemberships);
    assert.ok(eligibleTenantTenancies(after,"2026-09-12").some(row=>row.tenancyId==="new-tenancy"));
    assert.ok(!eligibleTenantTenancies(after,"2026-09-12").some(row=>row.tenancyId==="old-tenancy"));
    const identity={id:transferred.id,email:transferred.email,personId:transferred.personId,tenancyId:transferred.tenancyId,status:"active" as const};
    assert.equal(presentTenantHome(after,identity,"2026-09-12")?.tenancy.unitId,"new-unit");
    assert.equal(exactPaymentTenancy(after,identity).unit.id,"new-unit");
    assert.equal(presentTenantHome(after,identity,"2026-09-12")?.leases.length,0,"old lease remains attached to old tenancy, not presented as new-unit lease");
    assert.equal(presentTenantHome(after,identity,"2026-09-12")?.leaseFiles.length,0,"no history means no inherited file access");
    const history=await repository.readPortalTransferHistory(identity.id);
    assert.deepEqual(history,[{accountId:identity.id,personId:identity.personId,oldTenancyId:"old-tenancy",newTenancyId:"new-tenancy",occurredAt:context.occurredAt}]);
    assert.deepEqual(await repository.readPortalTransferHistory("other-account"),[]);
    const priorFiles=presentTenantHome(after,identity,"2026-09-12",history)!.leaseFiles;
    assert.equal(priorFiles.length,1);
    assert.equal(priorFiles[0].id,"verified-old-lease");
    assert.ok(priorFiles[0].priorUnitLabel);
    assert.equal(after.documents.find(row=>row.id==="verified-old-lease")?.tenancyId,"old-tenancy");
    assert.equal(after.tenancies.find(row=>row.id==="new-tenancy")?.actualMoveInOn,undefined,"no physical date is invented for portal access");
    await assert.rejects(()=>repository.transaction(tx=>tx.transferPortalAccountBinding!({...context,auditId:"replayed-transfer"})),/changed|ambiguous/);
    assert.equal((await db.query("SELECT id FROM rent_ops_activity_events WHERE id='replayed-transfer'")).rows.length,0);
  } finally {await db.close();}
});
