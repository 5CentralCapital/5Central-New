import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import session from "express-session";
import type { RentOpsDocument, RentOpsDocumentObjectBinding } from "../../../shared/rent-ops-contracts";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { createInMemoryObjectStore } from "../storage";
import { registerTenantPortalRoutes } from "./routes";
import { InMemoryTenantAccountStore } from "./test-store";
import { isTenantLeaseFile } from "./lease-files";

test("tenant lease PDF is proxied only for exact owner; unknown, cross-tenant, non-PDF and revoked requests fail", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const tenancy = snapshot.tenancies[0];
  const identity = {id:"account",email:"tenant@example.test",personId:tenancy.primaryPersonId,tenancyId:tenancy.id,status:"active" as const};
  const storage = createInMemoryObjectStore();
  const bytes = Buffer.from("%PDF-1.7\nSynthetic lease\n%%EOF");
  const object = await storage.putIfAbsent({bytes});
  const document: RentOpsDocument = {id:"private-lease",propertyId:tenancy.propertyId,unitId:tenancy.unitId,personId:tenancy.primaryPersonId,tenancyId:tenancy.id,type:"lease",typeKnowledge:"manual",state:"verified",stateKnowledge:"manual",availability:"verified",mimeType:"application/pdf",fileName:"lease.pdf",sizeBytes:object.sizeBytes,checksumSha256:object.checksumSha256,storageKey:`documents/${object.checksumSha256}`,storageKeyKnowledge:"source",verifiedAt:"2026-09-07T12:00:00Z"};
  snapshot.documents.push(document);
  const binding: RentOpsDocumentObjectBinding = {documentId:document.id,bindingKind:"import",sourceBinaryId:"b",importRunId:"run",sourceSystem:"rm",sourceCollection:"documents",backend:object.backend,logicalKey:object.logicalKey,checksumSha256:object.checksumSha256,sizeBytes:object.sizeBytes,immutableGeneration:object.immutableGeneration,verifiedAt:document.verifiedAt!};
  const repository = new SyntheticRentOpsRepository(snapshot);
  Object.assign(repository,{getDocumentObjectBinding:async (id:string) => id===document.id ? binding : undefined});
  const accounts = new InMemoryTenantAccountStore();
  await accounts.create({...identity,tokenHash:"token",expiresAt:"2026-09-08T00:00:00Z",now:"2026-09-07T00:00:00Z"});
  const active = await accounts.consumeActivation("token","synthetic-hash","2026-09-07T00:00:00Z");
  const app=express(); app.use(express.json()); app.use(session({secret:"synthetic-test-only-secret",resave:false,saveUninitialized:false}));
  // Isolated test login seam; production route still performs actual store,
  // session-version, and primary-tenancy authorization on every request.
  app.use((req,_res,next) => {if(req.get("x-test-login")==="yes") {req.session.tenantAccountId=identity.id; req.session.tenantSessionVersion=active!.sessionVersion;} next();});
  registerTenantPortalRoutes(app,{repository,accountStore:accounts,documentStorage:storage,requireAdmin:(_req,res)=>{res.sendStatus(403);}});
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(resolve=>server.once("listening",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/tenant`;
  const request=(path:string,auth=true)=>fetch(base+path,{headers:auth?{"x-test-login":"yes"}:{}});
  try {
    assert.equal((await request(`/lease-files/${document.id}/download`,false)).status,401);
    const home=await (await request("/home")).json();
    assert.deepEqual(home.leaseFiles,[{id:document.id,fileName:"lease.pdf",downloadPath:`/api/tenant/lease-files/${document.id}/download`}]);
    const response=await request(`/lease-files/${document.id}/download`);
    assert.equal(response.headers.get("content-security-policy"),"sandbox allow-downloads");
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(response.status,200); assert.equal(response.headers.get("content-type"),"application/pdf"); assert.equal(response.headers.get("cache-control"),"no-store"); assert.equal(response.headers.get("location"),null); assert.equal(await response.text(),bytes.toString());
    assert.equal((await request(`/lease-files/${document.id}/download?personId=other`)).status,404);
    assert.equal((await request("/lease-files/other-tenant-document/download")).status,404);
    for (const patch of [{personId:"other"},{tenancyId:"other"},{unitId:"other"},{propertyId:"other"},{type:"other"},{typeKnowledge:"unknown"},{applicationId:"internal"},{availability:"metadata"},{mimeType:"text/html"}]) {
      assert.equal(isTenantLeaseFile({...document,...patch} as RentOpsDocument,identity,tenancy),false);
    }
    const changed = {...document,typeKnowledge:"unknown" as const};
    await repository.saveDocument(changed);
    assert.equal((await request(`/lease-files/${document.id}/download`)).status,404);
    await repository.saveDocument({...document,personId:snapshot.people.find(p=>p.id!==identity.personId)!.id,tenancyId:undefined});
    assert.equal((await request(`/lease-files/${document.id}/download`)).status,404);
    const disguised = await storage.putIfAbsent({bytes:Buffer.from("<html>not a lease PDF</html>")});
    Object.assign(binding,{logicalKey:disguised.logicalKey,checksumSha256:disguised.checksumSha256,sizeBytes:disguised.sizeBytes,immutableGeneration:disguised.immutableGeneration});
    await repository.saveDocument({...document,checksumSha256:disguised.checksumSha256,sizeBytes:disguised.sizeBytes,storageKey:`documents/${disguised.checksumSha256}`});
    assert.equal((await request(`/lease-files/${document.id}/download`)).status,404);
    await accounts.revoke(identity.id,"2026-09-07T13:00:00Z");
    assert.equal((await request(`/lease-files/${document.id}/download`)).status,401);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
