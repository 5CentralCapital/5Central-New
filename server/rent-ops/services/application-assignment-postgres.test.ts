import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { registerRentOpsRoutes } from "../routes";
import { eligibleTenantTenancies } from "../tenant-portal/presentation";
import { APPLICATION_STATUS_TRANSITIONS } from "../../../shared/application-status-transitions";

test("imported unitless complete application can be assigned, reviewed and converted through audited HTTP on PostgreSQL v3", async () => {
 const db = new PGlite(); let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("CREATE ROLE qa_assignment_runtime; GRANT USAGE ON SCHEMA public TO qa_assignment_runtime");
  for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO qa_assignment_runtime`);
  await db.exec("SET ROLE qa_assignment_runtime");
  const adapt=(connection:any):RentOpsQueryExecutor=>({query:(sql,values)=>connection.query(sql,values?.map(v=>v===undefined?null:v)),transaction:work=>connection.transaction?connection.transaction((tx:any)=>work(adapt(tx))):work(adapt(connection))});
  const repo=new PostgresRentOpsRepository(adapt(db));
  for(const id of ["p","other"]) await repo.saveProperty({id,name:"Synthetic",slug:id,address:{line1:"1 Test Street",city:"Test",state:"FL",postalCode:"00000"},propertyType:"multifamily",state:"active",stateKnowledge:"manual"});
  await repo.saveUnit({id:"u",propertyId:"p",unitNumber:"1",readiness:"ready",listing:"listed",propertyLinkKnowledge:"manual",readinessKnowledge:"manual",listingKnowledge:"manual"});
  await repo.saveChargeDefinition({id:"rent",displayName:"Rent",displayNameKnowledge:"manual",category:"base_rent",categoryKnowledge:"manual",active:true,activeKnowledge:"manual"});
  await db.exec("RESET ROLE; CREATE ROLE rent_ops_staging_importer; GRANT USAGE ON SCHEMA public TO rent_ops_staging_importer; GRANT SELECT, INSERT, UPDATE ON rent_ops_applications TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
  await repo.saveApplication({id:"imported",sourceType:"rm_import",sourceTypeKnowledge:"source",status:"complete",statusKnowledge:"source",email:"synthetic@example.test",emailKnowledge:"source",firstName:"Synthetic",firstNameKnowledge:"source",lastName:"Applicant",lastNameKnowledge:"source",propertyId:"p",propertyLinkKnowledge:"exact",unitLinkKnowledge:"unknown",source:{system:"rent_manager",sourceId:"synthetic-application"},createdAt:"2026-09-01T00:00:00Z",updatedAt:"2026-09-01T00:00:00Z"});
  await db.exec("RESET ROLE; SET ROLE qa_assignment_runtime");
  const app=express();app.use(express.json());registerRentOpsRoutes(app,{repository:repo,requireAdmin:(req,_res,next)=>{req.rentOpsAdminUser={id:"synthetic-manager"} as any;next();}});
  server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server!.once("listening",r));const base=`http://127.0.0.1:${(server.address() as any).port}/api/rent-ops/applications/imported`;
  const send=(suffix:string,body:unknown,method="PATCH")=>fetch(base+suffix,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await repo.getSnapshot()).modelVersion,3);
  assert.deepEqual(APPLICATION_STATUS_TRANSITIONS.complete,["under_review","missing_information","withdrawn"]);
  assert.equal((await send("",{revision:1,propertyId:"other",unitId:"u"})).status,400);
  assert.equal((await send("/status",{revision:1,status:"approved"})).status,400);
  let response=await send("",{revision:1,propertyId:"p",unitId:"u"});assert.equal(response.status,200,await response.text());
  let row=(await repo.getSnapshot()).applications[0];assert.equal(row.unitId,"u");assert.equal(row.unitLinkKnowledge,"manual");assert.equal(row.status,"complete");assert.equal(row.statusKnowledge,"source");assert.equal(row.propertyLinkKnowledge,"exact");assert.equal(row.source?.sourceId,"synthetic-application");
  assert.equal((await send("",{revision:1,propertyId:"p",unitId:"u"})).status,409);
  response=await send("/status",{revision:2,status:"under_review"});assert.equal(response.status,200,await response.text());
  response=await send("/status",{revision:3,status:"approved",note:"Synthetic manager reviewed explicit facts"});assert.equal(response.status,200,await response.text());
  const facts={propertyId:"p",unitId:"u",plannedMoveInOn:"2027-10-01",leaseStatus:"draft",contractStartOn:"2027-10-01",contractEndOn:"2028-09-30",monthToMonth:false,baseRentCents:125000,chargeDefinitionId:"rent",category:"base_rent",scheduleDescription:"Monthly rent",primaryFinanciallyResponsible:true,members:[{applicationMemberId:"primary",role:"primary",isFinanciallyResponsible:true}]};
  response=await send("/convert",facts,"POST");assert.equal(response.status,201,await response.text());
  const snapshot=await repo.getSnapshot();assert.equal(snapshot.tenancies.length,1);assert.equal(snapshot.leaseTerms[0].status,"draft");assert.equal(eligibleTenantTenancies(snapshot)[0]?.tenancyId,snapshot.tenancies[0].id);
  row=snapshot.applications[0];assert.equal(row.status,"converted");assert.equal((await send("",{revision:row.recordRevision,propertyId:"other",unitId:"u"})).status,400);
  const changes=await repo.getRecordChanges();assert.ok(changes.some(change=>change.targetId==="imported" && change.changedFields.includes("unitId") && change.actorSubject==="synthetic-manager"));
 } finally {if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await db.close();}
});
