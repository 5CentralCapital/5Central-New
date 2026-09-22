import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import session from "express-session";
import { syntheticRentOpsSnapshot } from "./fixtures/synthetic";
import { SyntheticRentOpsRepository } from "./repositories/synthetic";
import { registerRentOpsRoutes } from "./routes";
import { registerTenantPortalRoutes } from "./tenant-portal/routes";
import { InMemoryTenantAccountStore } from "./tenant-portal/test-store";
import { eligibleTenantTenancies } from "./tenant-portal/presentation";
import { mutationPayload } from "../../client/src/features/rent-ops/form-payload";

test("Quick Add manual tenancy and lease retain explicit knowledge and support an exact tenant account grant",async()=>{
 const snapshot=structuredClone(syntheticRentOpsSnapshot());snapshot.modelVersion=3;const unit=snapshot.units[0];unit.propertyLinkKnowledge="exact";
 const repository=new SyntheticRentOpsRepository(snapshot),accounts=new InMemoryTenantAccountStore();
 const app=express();app.use(express.json());app.use(session({secret:"synthetic-only-session-secret",resave:false,saveUninitialized:false}));
 const requireAdmin:express.RequestHandler=(req,_res,next)=>{req.rentOpsAdminUser={id:"manager"} as any;next();};
 registerRentOpsRoutes(app,{repository,requireAdmin});registerTenantPortalRoutes(app,{repository,accountStore:accounts,requireAdmin});
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const base=`http://127.0.0.1:${(server.address() as any).port}/api/rent-ops`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 try{
  const input=mutationPayload("save-tenancy",{id:"manual:grant-ready",propertyId:unit.propertyId,unitId:unit.id,primaryPersonId:snapshot.people[0].id,status:"future",plannedMoveInOn:"2027-01-01"});
  assert.equal((await post("/tenancies",input)).status,201);
  const tenancy=(await repository.getSnapshot()).tenancies.find(t=>t.id===input.id)!;
  for(const key of ["statusKnowledge","propertyLinkKnowledge","unitLinkKnowledge","primaryPersonLinkKnowledge","plannedMoveInKnowledge","createdAtKnowledge"] as const)assert.equal(tenancy[key],"manual");
  assert.equal(tenancy.actualMoveInOn,undefined);assert.equal(tenancy.actualMoveInKnowledge,undefined);assert.equal(tenancy.source,undefined);
  assert.ok(eligibleTenantTenancies(await repository.getSnapshot()).some(t=>t.tenancyId===tenancy.id));
  const leaseInput=mutationPayload("save-lease-term",{id:"manual:grant-lease",tenancyId:tenancy.id,status:"draft",contractStartOn:"2027-01-01",monthToMonth:true});
  assert.equal((await post("/lease-terms",leaseInput)).status,201);const lease=(await repository.getSnapshot()).leaseTerms.find(t=>t.id===leaseInput.id)!;
  for(const key of ["tenancyLinkKnowledge","statusKnowledge","contractStartKnowledge","monthToMonthKnowledge","createdAtKnowledge"] as const)assert.equal(lease[key],"manual");
  assert.equal(lease.contractEndOn,undefined);assert.equal(lease.contractEndKnowledge,undefined);assert.equal(lease.signedOnKnowledge,undefined);
  const result=await post("/tenant-accounts",{email:"manual.primary@example.test",personId:tenancy.primaryPersonId,tenancyId:tenancy.id});assert.equal(result.status,201);const account=await accounts.getByEmail("manual.primary@example.test");assert.equal(account?.personId,tenancy.primaryPersonId);assert.equal(account?.tenancyId,tenancy.id);assert.equal(account?.status,"pending");
  assert.equal((await post("/tenancies",{...input,status:"current",actualMoveInOn:"2027-01-01"})).status,400);assert.deepEqual((await repository.getSnapshot()).tenancies.find(t=>t.id===tenancy.id),tenancy);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("native property to account chain survives actual PostgreSQL v3 knowledge defaults",async()=>{
 const {PGlite}=await import("@electric-sql/pglite");const {ensureRentOpsSchema}=await import("./persistence");const {PostgresRentOpsRepository}=await import("./repositories/postgres");const {PostgresTenantAccountStore}=await import("./tenant-portal/store");
 const db=new PGlite();let server:ReturnType<typeof app.listen>|undefined;const app=express();
 try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  const wrap=(connection:Pick<InstanceType<typeof PGlite>,"query"|"transaction">):import("./repositories/postgres").RentOpsQueryExecutor=>({async query<T>(sql,args){
   // Test owner is required for schema setup; this seam bypasses only the runtime IAM audit.
   if(sql.includes("has_table_privilege"))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};
   return connection.query<T>(sql,args?.map(v=>v===undefined?null:v));
  },transaction:work=>typeof connection.transaction === "function" ? connection.transaction(tx=>work(wrap(tx as unknown as InstanceType<typeof PGlite>))) : work(wrap(connection))});
  const executor=wrap(db);
  const repository=new PostgresRentOpsRepository(executor),accounts=new PostgresTenantAccountStore(executor);
  app.use(express.json());app.use(session({secret:"synthetic-only-session-secret",resave:false,saveUninitialized:false}));const requireAdmin:express.RequestHandler=(req,_res,next)=>{req.rentOpsAdminUser={id:"manager"} as any;next();};registerRentOpsRoutes(app,{repository,requireAdmin});registerTenantPortalRoutes(app,{repository,accountStore:accounts,requireAdmin});
  server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server!.once("listening",r));const base=`http://127.0.0.1:${(server.address() as any).port}/api/rent-ops`;
  const create=async(path:string,action:Parameters<typeof mutationPayload>[0],values:Parameters<typeof mutationPayload>[1])=>{const response=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(mutationPayload(action,values))});assert.equal(response.status,201,`${path}: ${await response.text()}`);};
  await create("/properties","save-property",{id:"native-property",name:"Synthetic property",slug:"native-property",address1:"1 Test Street",city:"Test",stateCode:"FL",postalCode:"00000",propertyType:"single_family",propertyState:"active"});
  await create("/units","save-unit",{id:"native-unit",propertyId:"native-property",unitNumber:"1",readiness:"ready",listing:"listed",bedrooms:"",bathrooms:"",marketRentDollars:""});
  await create("/people","save-person",{id:"native-person",firstName:"Synthetic",lastName:"Tenant",email:"native@example.test"});
  const personAudit=(await db.query<{actor_subject:string;revision:number}>("SELECT actor_subject,revision FROM rent_ops_record_changes WHERE entity_type='person' AND target_id='native-person'")).rows;
  assert.deepEqual(personAudit,[{actor_subject:"manager",revision:1}]);
  let snapshot=await repository.getSnapshot();assert.equal(snapshot.modelVersion,3);assert.equal(snapshot.properties[0].stateKnowledge,"manual");assert.equal(snapshot.properties[0].nameKnowledge,"manual");assert.equal(snapshot.units[0].propertyLinkKnowledge,"manual");assert.equal(snapshot.units[0].listingKnowledge,"manual");assert.equal(snapshot.people[0].emailKnowledge,"manual");assert.notEqual(snapshot.people[0].archived,false);assert.notEqual(snapshot.people[0].phoneKnowledge,"manual");
  const listings=await (await fetch(base+"/public/listings")).json();assert.equal(listings.length,1);assert.equal(listings[0].units[0].id,"native-unit");
  await create("/tenancies","save-tenancy",{id:"native-tenancy",propertyId:"native-property",unitId:"native-unit",primaryPersonId:"native-person",status:"future",plannedMoveInOn:"2027-01-01"});
  await create("/lease-terms","save-lease-term",{id:"native-lease",tenancyId:"native-tenancy",status:"draft",contractStartOn:"2027-01-01",contractEndOn:"2027-12-31",monthToMonth:false});
  snapshot=await repository.getSnapshot();assert.ok(eligibleTenantTenancies(snapshot).some(t=>t.tenancyId==="native-tenancy"));assert.equal(snapshot.leaseTerms[0].monthToMonthKnowledge,"manual");assert.equal(snapshot.leaseTerms[0].contractEndKnowledge,"manual");assert.notEqual(snapshot.leaseTerms[0].signedOnKnowledge,"manual");assert.notEqual(snapshot.tenancies[0].actualMoveInKnowledge,"manual");
  const grant=await fetch(base+"/tenant-accounts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"native@example.test",personId:"native-person",tenancyId:"native-tenancy"})});assert.equal(grant.status,201,await grant.text());const account=await accounts.getByEmail("native@example.test");assert.equal(account?.tenancyId,"native-tenancy");assert.equal(account?.status,"pending");assert.equal(account?.passwordHash,null);
 }finally{if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await db.close();}
});
