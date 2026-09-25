import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import {
  S3CompatiblePrivateVersionedObjectStoreClient,
  signS3Request,
  createProductionRentOpsObjectStoresFromEnv,
  createProductionRentOpsWebObjectStoresFromEnv,
  type S3CompatibleTransport,
} from "./object-store";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const bytes = Buffer.from("S3-compatible immutable bytes");
const checksum = digest(bytes);
const logicalKey = `sha256:${checksum}`;

function signedIdentity(init?: RequestInit): string {
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  return /Credential=([^/]+)/.exec(authorization)?.[1] ?? "";
}

test("SigV4 signatures match the published AWS S3 examples", () => {
  // AWS S3 API reference, "Signature Calculations for the Authorization Header":
  // GET Object with a Range header, and GET Bucket (list) with a query string.
  const credentials = { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z") };
  const object = signS3Request({ ...credentials, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" } });
  assert.equal(object.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  const list = signS3Request({ ...credentials, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J") });
  assert.equal(list.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("S3-compatible adapter signs HTTPS requests, streams bodies, and binds exact version IDs", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: S3CompatibleTransport = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const method = String(init.method ?? "GET").toUpperCase();
    if (method === "PUT") return new Response(null, { status: 200, headers: { "x-amz-version-id": "version-1" } });
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "x-amz-version-id": "version-1", "content-length": String(bytes.length) } });
    if (method === "GET") return new Response(bytes, { status: 200, headers: { "x-amz-version-id": "version-1", "content-length": String(bytes.length) } });
    return new Response(null, { status: 403 });
  };
  const client = new S3CompatiblePrivateVersionedObjectStoreClient({
    endpoint: "https://objects.example",
    region: "us-east-1",
    bucket: "private-bucket",
    prefix: "rent-ops/private",
    accessKeyId: "upload-identity",
    secretAccessKey: "secret-must-not-leak",
    transport,
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });

  const stored = await client.putIfAbsent({ logicalKey, body: Readable.from([bytes]), checksumSha256: checksum, sizeBytes: bytes.length });
  assert.deepEqual(stored, { existed: false, immutableVersion: "version-1" });
  const stat = await client.stat(logicalKey, { immutableVersion: "version-1" });
  assert.equal(stat?.immutableVersion, "version-1");
  const verified = await client.verify(logicalKey, { immutableVersion: "version-1", expectedChecksumSha256: checksum, expectedSizeBytes: bytes.length });
  assert.equal(verified.verificationState, "verified");
  assert.deepEqual(Buffer.concat(await (async () => { const chunks: Buffer[] = []; for await (const chunk of await client.open(logicalKey, { immutableVersion: "version-1" })) chunks.push(Buffer.from(chunk)); return chunks; })()), bytes);
  assert.ok(calls.every((call) => call.url.startsWith("https://objects.example/")));
  const firstHeaders = new Headers(calls[0]?.init.headers);
  assert.match(firstHeaders.get("authorization") ?? "", /AWS4-HMAC-SHA256/);
  assert.equal(firstHeaders.get("authorization")?.includes("secret-must-not-leak"), false);
  assert.equal(calls[0]?.init.redirect, "error");
  await assert.rejects(() => client.open(logicalKey, { immutableVersion: "wrong-version" }), /storage_version_mismatch/);
});

function productionFixture(overrides: Partial<Record<"head" | "put" | "list" | "delete" | "versionedRead", number>> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: S3CompatibleTransport = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const parsed = new URL(url);
    const method = String(init.method ?? "GET").toUpperCase();
    const identity = signedIdentity(init);
    if (parsed.searchParams.has("versioning")) return new Response("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>", { status: 200 });
    if (method === "HEAD" && !new Headers(init.headers).has("authorization")) return new Response(null, { status: 403 });
    if (parsed.searchParams.get("list-type") === "2") return new Response(null, { status: overrides.list ?? 403 });
    if (method === "DELETE") return new Response(null, { status: overrides.delete ?? 403 });
    if ((method === "GET" || method === "HEAD") && parsed.searchParams.has("versionId") && overrides.versionedRead) return new Response(null, { status: overrides.versionedRead });
    if (method === "GET") return new Response(Buffer.from("probe"), { status: 200, headers: { "x-amz-version-id": "probe-version" } });
    if (method === "HEAD") {
      return new Response(null, { status: overrides.head ?? 200, headers: { "x-amz-version-id": "probe-version", "content-length": "5" } });
    }
    if (method === "PUT") return identity === "runtime-get" ? new Response(null, { status: overrides.put ?? 403 }) : new Response(null, { status: 412 });
    return new Response(null, { status: 403 });
  };
  const env = {
    RENT_OPS_OBJECT_STORE_BACKEND: "private-versioned",
    RENT_OPS_OBJECT_STORE_ENDPOINT: "https://objects.example",
    RENT_OPS_OBJECT_STORE_REGION: "us-east-1",
    RENT_OPS_OBJECT_STORE_BUCKET: "private-bucket",
    RENT_OPS_OBJECT_STORE_PREFIX: "rent-ops/private",
    RENT_OPS_OBJECT_STORE_ENCRYPTION: "required",
    RENT_OPS_OBJECT_STORE_VERSIONING: "required",
    RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY: "runtime-get",
    RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN: "runtime-secret",
    RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY: "applicant-upload",
    RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN: "upload-secret",
    RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY: "restricted-importer",
    RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN: "importer-secret",
  };
  return { calls, transport, env };
}

test("production S3 factory accepts S3 Head/Get runtime permissions and rejects all write/list/delete capabilities", async () => {
  const { calls, transport, env } = productionFixture();
  const stores = await createProductionRentOpsObjectStoresFromEnv({ env, transport });
  assert.equal("putIfAbsent" in stores.documentStorage, false);
  assert.equal(stores.privilegeReport.privateOnly, true);
  assert.equal(stores.privilegeReport.versioningEnabled, true);
  assert.equal(stores.privilegeReport.runtime.privileges.head, true);
  assert.equal(stores.privilegeReport.runtime.privileges.put, false);
  assert.equal(stores.privilegeReport.runtime.privileges.list, false);
  assert.equal(stores.privilegeReport.runtime.privileges.delete, false);
  assert.equal(stores.privilegeReport.uploadWriter?.privileges.put, true);
  assert.equal(stores.privilegeReport.importer.privileges.delete, false);
  assert.ok(calls.length >= 15);
  const reads = calls.filter(call => ["GET", "HEAD"].includes(String(call.init.method)) && new URL(call.url).pathname.endsWith("/sha256/" + "0".repeat(64)) && new Headers(call.init.headers).has("authorization"));
  assert.ok(reads.some(call => String(call.init.method) === "GET" && new URL(call.url).searchParams.get("versionId") === "probe-version"), "the canary GET probe is an exact-version read");
  assert.equal(JSON.stringify(calls).includes("runtime-secret"), false);
  assert.equal(JSON.stringify(calls).includes("upload-secret"), false);
  assert.equal(JSON.stringify(calls).includes("importer-secret"), false);
});

test("S3 startup rejects denied reads, successful forbidden operations, and inconclusive probe responses", async () => {
  for (const overrides of [
    { head: 403 },
    { put: 412 },
    { list: 200 },
    { delete: 204 },
    { delete: 200 },
    { put: 500 },
    { list: 500 },
    { delete: 400 },
    { delete: 404 },
    { versionedRead: 403 },
  ]) {
    const { transport, env } = productionFixture(overrides);
    await assert.rejects(() => createProductionRentOpsObjectStoresFromEnv({ env, transport }), /storage_privilege_probe_failed/);
    const webEnv: Record<string,string> = {...env};
    delete webEnv.RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN; delete webEnv.RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY;
    await assert.rejects(() => createProductionRentOpsWebObjectStoresFromEnv({ env: webEnv, transport }), /storage_privilege_probe_failed/);
  }
});

test("S3 adapter refuses missing immutable version IDs", async () => {
  const client = new S3CompatiblePrivateVersionedObjectStoreClient({
    endpoint: "https://objects.example",
    region: "us-east-1",
    bucket: "private-bucket",
    prefix: "rent-ops/private",
    accessKeyId: "runtime-get",
    secretAccessKey: "runtime-secret",
    transport: async () => new Response(null, { status: 200, headers: { "content-length": "1" } }),
  });
  await assert.rejects(() => client.stat(logicalKey), /storage_version_missing/);
});

test("web storage probes only its two principals and rejects importer credentials before network", async () => {
 const {env:full,transport,calls}=productionFixture();
 const env:Record<string,string>={...full};
 delete env.RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN; delete env.RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY;
 const stores=await createProductionRentOpsWebObjectStoresFromEnv({env,transport});
 assert.equal("importerStorage" in stores,false);
 assert.equal("importer" in stores.privilegeReport,false);
 assert.equal(JSON.stringify(calls).includes("restricted-importer"),false);
 for(const key of ["RENT_OPS_DATABASE_URL","RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN"]){
  const before=calls.length;
  await assert.rejects(()=>createProductionRentOpsWebObjectStoresFromEnv({env:{...env,[key]:"operator-secret"},transport}),/storage_privilege_probe_failed/);
  assert.equal(calls.length,before);
 }
 await assert.rejects(()=>createProductionRentOpsObjectStoresFromEnv({env,transport}),/storage_privilege_probe_failed/);
});
