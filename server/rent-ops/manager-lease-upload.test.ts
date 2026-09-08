import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { syntheticRentOpsSnapshot } from "./fixtures/synthetic";
import { SyntheticRentOpsRepository } from "./repositories/synthetic";
import { registerRentOpsRoutes } from "./routes";
import { createInMemoryObjectStore } from "./storage";
import { isTenantLeaseFile } from "./tenant-portal/lease-files";
import { RentOpsService } from "./services/service";
import type { RentOpsDocumentObjectBinding } from "../../shared/rent-ops-contracts";

test("manager PDF upload resolves exact parents, rejects unauthorized/scoped/invalid bytes and persists truthful binding", async () => {
 const snapshot=structuredClone(syntheticRentOpsSnapshot()); const tenancy=snapshot.tenancies[0];
 const repo=new SyntheticRentOpsRepository(snapshot); const bindings=new Map<string,RentOpsDocumentObjectBinding>();
 Object.assign(repo,{saveDocumentObjectBinding:async(b:RentOpsDocumentObjectBinding)=>{bindings.set(b.documentId,b);return b;},getDocumentObjectBinding:async(id:string)=>bindings.get(id)});
 const originalTransaction=repo.transaction.bind(repo);
 repo.transaction=(work, options)=>originalTransaction(async transactionRepo=>{ Object.assign(transactionRepo,{saveDocumentObjectBinding:async(b:RentOpsDocumentObjectBinding)=>{bindings.set(b.documentId,b);return b;}}); return work(transactionRepo); },options);
 const storage=createInMemoryObjectStore();const app=express();app.use(express.json());
 registerRentOpsRoutes(app,{repository:repo,documentStorage:storage,documentUploadStorage:storage,documentUploadMaxBytes:100,requireAdmin:(req,res,next)=>{if(req.get("x-test-admin")!=="yes"){res.sendStatus(401);return;}if(req.method==="POST" && req.get("x-test-csrf")!=="valid"){res.sendStatus(403);return;}req.rentOpsAdminUser={id:"manager"} as any;next();}});
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const base=`http://127.0.0.1:${(server.address() as any).port}/api/rent-ops`;
 const body=Buffer.from("%PDF-1.7\nSynthetic lease\n%%EOF");const headers={"x-test-admin":"yes","x-test-csrf":"valid","content-type":"application/pdf","x-document-name":"lease.pdf"};
 const upload=(patch:Record<string,string>={},bytes:Buffer=body,path=`/tenancies/${encodeURIComponent(tenancy.id)}/lease-files`)=>fetch(base+path,{method:"POST",headers:{...headers,...patch},body:bytes});
 try{
  assert.equal((await upload({"x-test-admin":"no"})).status,401);assert.equal((await upload({"x-test-csrf":"bad"})).status,403);
  assert.equal((await upload({"x-person-id":"other"})).status,400);assert.equal((await upload({},body,`/tenancies/${encodeURIComponent(tenancy.id)}/lease-files?personId=other`)).status,400);
  assert.equal((await upload({"content-type":"text/plain"})).status,400);assert.equal((await upload({},Buffer.from("not a PDF"))).status,400);assert.equal((await upload({},Buffer.alloc(101))).status,400);assert.equal((await upload({"x-document-name":"../lease.pdf"})).status,400);
  assert.equal((await upload({},body,"/tenancies/missing/lease-files")).status,404);
  const response=await upload();assert.equal(response.status,201);const result=await response.json();assert.equal(result.documents.length,1);const document=(await repo.getSnapshot()).documents.find(d=>d.id===result.document.id)!;
  assert.equal(document.typeKnowledge,"manual");assert.equal(document.stateKnowledge,"manual");assert.equal(document.personId,tenancy.primaryPersonId);assert.equal(document.propertyId,tenancy.propertyId);assert.equal(document.unitId,tenancy.unitId);assert.equal(document.tenancyId,tenancy.id);assert.equal(document.applicationId,undefined);
  assert.equal(bindings.get(document.id)?.bindingKind,"admin");assert.equal(bindings.get(document.id)?.sourceBinaryId,undefined);
  const identity={id:"tenant",email:"tenant@example.test",personId:tenancy.primaryPersonId,tenancyId:tenancy.id,status:"active" as const};assert.equal(isTenantLeaseFile(document,identity,tenancy),true);assert.equal(isTenantLeaseFile(document,{...identity,personId:"other"},tenancy),false);
  assert.equal(isTenantLeaseFile(document,{...identity,tenancyId:"other"},tenancy),false);
  const service=new RentOpsService(repo,()=>new Date(),undefined,undefined,false,{documentStorage:storage});const opened=await service.openVerifiedDocument(document.id);let actual="";for await(const part of opened.stream)actual+=part.toString();assert.equal(actual,body.toString());
  const event=(await repo.getSnapshot()).activityEvents.find(a=>a.summary?.includes("Manager uploaded"));assert.equal(event?.actor,"manager");
  assert.equal((await fetch(base+"/documents",{method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}"})).status,503);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
