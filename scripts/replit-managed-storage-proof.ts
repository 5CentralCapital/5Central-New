/** Run only inside the app's private Replit development Shell. No source documents. */
import { Client } from "@replit/object-storage";
import { createHash } from "node:crypto";
import { createReplitManagedGcsObjectStores, type ManagedBucket } from "../server/rent-ops/storage/replit-managed-gcs";

async function main() {
  const bucketId = process.env.RENT_OPS_OBJECT_STORE_BUCKET;
  if (!bucketId) throw new Error("bucket configuration required");
  const sdk = new Client({ bucketId });
  // Replit publicly documents getBucket; package1.0.0 marks it private in declarations.
  const bucket = await (sdk as unknown as { getBucket(): Promise<ManagedBucket> }).getBucket();
  const stores = await createReplitManagedGcsObjectStores({ bucket, prefix: process.env.RENT_OPS_OBJECT_STORE_PREFIX ?? "rent-ops" });
  const bytes = Buffer.from("5Central managed storage adapter synthetic proof v1\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const first = await stores.importerStorage.putIfAbsent({ bytes, expectedChecksumSha256: sha, expectedSizeBytes: bytes.length });
  const duplicate = await stores.importerStorage.putIfAbsent({ bytes, expectedChecksumSha256: sha, expectedSizeBytes: bytes.length });
  if (duplicate.created || duplicate.immutableGeneration !== first.immutableGeneration) throw new Error("create-only verification failed");
  const opened = await stores.documentStorage.openVerified(first.logicalKey, { immutableGeneration: first.immutableGeneration, expectedChecksumSha256: sha, expectedSizeBytes: bytes.length });
  const hash = createHash("sha256"); let size = 0;
  for await (const part of opened.stream) { hash.update(part); size += part.length; }
  if (hash.digest("hex") !== sha || size !== bytes.length) throw new Error("read verification failed");
  let wrongGenerationRejected = false;
  try { await stores.documentStorage.openVerified(first.logicalKey, { immutableGeneration: "1" }); } catch { wrongGenerationRejected = true; }
  if (!wrongGenerationRejected) throw new Error("generation refusal failed");
  console.log(JSON.stringify({ proof: "replit-managed-gcs-adapter-v1", bucket: bucket.name, logicalKey: first.logicalKey, sha256: sha, sizeBytes: size, generation: first.immutableGeneration, duplicatePreserved: true, wrongGenerationRejected, pinnedHashAndSizeVerified: true, readiness: stores.managedHostingReport }));
}
main().catch(() => { console.error("Managed storage proof failed; no credentials or provider error body logged."); process.exitCode = 1; });
