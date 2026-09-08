import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { ReplitManagedGcsClient, createReplitManagedGcsObjectStores, type ManagedBucket } from "./replit-managed-gcs";
function fixture() {
  const objects = new Map<string, { bytes: Buffer; generation: string }>();
  const bucket: ManagedBucket = { name: "private-test", iam: { async testPermissions(p) { return [Object.fromEntries(p.map(k => [k, true]))]; } }, file(key, opts) {
    return { createWriteStream(options: any) { const chunks: Buffer[] = []; return new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); }, final(cb) { assert.equal(options.preconditionOpts.ifGenerationMatch, 0); if(objects.has(key)) return cb(Object.assign(new Error(), {code:412})); objects.set(key,{bytes:Buffer.concat(chunks),generation:"123"}); cb(); } }); }, async getMetadata() { const v=objects.get(key); if(!v || (opts && opts.generation !== v.generation)) throw Object.assign(new Error(),{code:404}); return [{size:v.bytes.length,generation:v.generation}]; }, createReadStream() { const v=objects.get(key)!; return Readable.from([v.bytes]); } };
  } };
  const client = new ReplitManagedGcsClient(bucket,"documents");
  const bytes=Buffer.from("synthetic private content"); const hash=createHash("sha256").update(bytes).digest("hex"); const key=`sha256:${hash}`;
  return {bucket,client,bytes,hash,key,objects,put:()=>client.putIfAbsent({logicalKey:key,body:Readable.from([bytes]),checksumSha256:hash,sizeBytes:bytes.length})};
}
test("create-only write, duplicate preservation and exact generation read",async()=>{const f=fixture();assert.equal((await f.put()).existed,false);assert.equal((await f.put()).existed,true);assert.equal((await f.client.verify(f.key,{immutableGeneration:"123"})).verificationState,"verified");await assert.rejects(f.client.openVerified(f.key,{immutableGeneration:"124"}));await assert.rejects(f.client.open(f.key));await assert.rejects(f.client.stat("../outside"));});
test("corrupt provider bytes and expected size fail closed",async()=>{const f=fixture();await f.put();await assert.rejects(f.client.verify(f.key,{expectedSizeBytes:1}));f.objects.get(`documents/sha256/${f.hash}`)!.bytes=Buffer.from("corrupt");await assert.rejects(f.client.verify(f.key));});
test("managed report tells truth about broad identity and rejects public probe",async()=>{const f=fixture();const result=await createReplitManagedGcsObjectStores({bucket:f.bucket,prefix:"documents",anonymousFetch:async()=>new Response(null,{status:403})});assert.equal(result.managedHostingReport.nativeVersionRetentionVerified,false);assert.equal(result.managedHostingReport.providerPermissions["storage.objects.delete"],true);assert.equal("putIfAbsent" in result.documentStorage,false);assert.equal("delete" in result.documentUploadStorage,false);await assert.rejects(createReplitManagedGcsObjectStores({bucket:f.bucket,prefix:"documents",anonymousFetch:async()=>new Response(null,{status:200})}));});
