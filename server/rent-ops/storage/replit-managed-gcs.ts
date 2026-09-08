import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checksumForLogicalKey, normalizeLogicalKey } from "./keys";
import { storageError } from "./errors";
import { BoundedUploadObjectStore, SpoolingPrivateVersionedObjectStoreAdapter, createReadOnlyObjectStoreAdapter } from "./object-store";
import type { PrivateVersionedObjectStoreClient, StorageVersionOptions, VerificationOptions } from "./types";

// Structural boundary keeps the documented GCS bucket available for deterministic tests.
export interface ManagedBucket {
  name: string;
  file(name: string, options?: { generation: string }): {
    createWriteStream(options: object): NodeJS.WritableStream;
    createReadStream(): Readable;
    getMetadata(): Promise<[Record<string, any>]>;
  };
  iam: { testPermissions(permissions: string[]): Promise<[Record<string, boolean>]> };
}
const backend = "replit-managed-gcs";
function generation(options: StorageVersionOptions = {}) {
  const values = [options.immutableGeneration, options.expectedImmutableGeneration, options.generation, options.immutableVersion, options.expectedImmutableVersion, options.version].filter(x => x !== undefined);
  if (values.some(x => !/^\d+$/.test(x!)) || new Set(values).size > 1) throw storageError("storage_version_mismatch");
  return values[0];
}
export class ReplitManagedGcsClient implements PrivateVersionedObjectStoreClient {
  constructor(readonly bucket: ManagedBucket, readonly prefix: string, readonly maxBytes = 50 * 1024 * 1024) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw storageError("storage_logical_key_invalid");
  }
  private file(key: string, options: StorageVersionOptions = {}) {
    const value = generation(options);
    return this.bucket.file(`${this.prefix}/sha256/${checksumForLogicalKey(key)}`, value ? { generation: value } : undefined);
  }
  async stat(key: string, options: StorageVersionOptions = {}) {
    try {
      const [m] = await this.file(key, options).getMetadata();
      if (!/^\d+$/.test(String(m.generation))) throw storageError("storage_version_missing");
      if (generation(options) && generation(options) !== String(m.generation)) throw storageError("storage_version_mismatch");
      const size = Number(m.size);
      if (!Number.isSafeInteger(size) || size < 1 || size > this.maxBytes) throw storageError("storage_size_mismatch");
      return { backend, logicalKey: normalizeLogicalKey(key), checksumSha256: checksumForLogicalKey(key), sizeBytes: size, immutableGeneration: String(m.generation) };
    } catch (error: any) { if (Number(error.code) === 404) return null; throw error; }
  }
  async putIfAbsent(input: Parameters<PrivateVersionedObjectStoreClient["putIfAbsent"]>[0]) {
    if (checksumForLogicalKey(input.logicalKey) !== input.checksumSha256) throw storageError("storage_checksum_mismatch");
    if (input.sizeBytes < 1 || input.sizeBytes > this.maxBytes) throw storageError("storage_size_mismatch");
    let existed = false;
    try {
      await pipeline(Readable.from(input.body), this.file(input.logicalKey).createWriteStream({ resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } }));
    } catch (error: any) { if (Number(error.code) !== 412) throw error; existed = true; }
    const stat = await this.stat(input.logicalKey);
    if (!stat) throw storageError("storage_object_not_found");
    await this.verify(input.logicalKey, { immutableGeneration: stat.immutableGeneration, expectedChecksumSha256: input.checksumSha256, expectedSizeBytes: input.sizeBytes });
    return { existed, immutableGeneration: stat.immutableGeneration };
  }
  async open(key: string, options: StorageVersionOptions = {}) {
    if (!generation(options)) throw storageError("storage_version_missing");
    return this.file(key, options).createReadStream();
  }
  async openVerified(key: string, options: VerificationOptions = {}) {
    if (!generation(options)) throw storageError("storage_version_missing");
    const stat = await this.stat(key, options);
    if (!stat) throw storageError("storage_object_not_found");
    const chunks: Buffer[] = []; let size = 0; const hash = createHash("sha256");
    for await (const chunk of await this.open(key, options)) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > this.maxBytes) throw storageError("storage_size_mismatch");
      hash.update(bytes); chunks.push(bytes);
    }
    const checksum = hash.digest("hex");
    if (checksum !== checksumForLogicalKey(key) || (options.expectedChecksumSha256 && checksum !== options.expectedChecksumSha256)) throw storageError("storage_checksum_mismatch");
    if (size !== stat.sizeBytes || (options.expectedSizeBytes !== undefined && size !== options.expectedSizeBytes)) throw storageError("storage_size_mismatch");
    return { stream: Readable.from(chunks), verification: { ...stat, checksumSha256: checksum, verificationState: "verified" as const, verifiedAt: new Date().toISOString() } };
  }
  async verify(key: string, options: VerificationOptions = {}) {
    const stat = await this.stat(key, options);
    if (!stat) throw storageError("storage_object_not_found");
    const opened = await this.openVerified(key, { ...options, immutableGeneration: stat.immutableGeneration });
    opened.stream.destroy(); return opened.verification;
  }
}

export async function createReplitManagedGcsObjectStores(options: {
  bucket: ManagedBucket; prefix: string; spoolRoot?: string; maxUploadConcurrency?: number;
  anonymousFetch?: typeof fetch;
}) {
  const client = new ReplitManagedGcsClient(options.bucket, options.prefix);
  const [permissions] = await options.bucket.iam.testPermissions(["storage.objects.get", "storage.objects.create", "storage.objects.list", "storage.objects.delete", "storage.objects.update"]);
  if (!permissions["storage.objects.get"] || !permissions["storage.objects.create"]) throw storageError("storage_privilege_probe_failed");
  // A real keyed private probe, not a nonexistent-object test. Harmless content is deterministic.
  const bytes = Buffer.from("5Central managed storage readiness probe v1\n");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await client.putIfAbsent({ logicalKey: `sha256:${checksum}`, body: Readable.from([bytes]), checksumSha256: checksum, sizeBytes: bytes.length });
  const response = await (options.anonymousFetch ?? fetch)(`https://storage.googleapis.com/${encodeURIComponent(options.bucket.name)}/${options.prefix}/sha256/${checksum}`, { redirect: "error" });
  await response.body?.cancel();
  if (response.status !== 403 && response.status !== 401) throw storageError("storage_privilege_probe_failed");
  const store = new SpoolingPrivateVersionedObjectStoreAdapter(client, { spoolRoot: options.spoolRoot });
  // Override the generic wrapper's legacy backend label without weakening its validations.
  Object.defineProperty(store, "backend", { value: backend });
  return {
    documentStorage: createReadOnlyObjectStoreAdapter(store),
    documentUploadStorage: new BoundedUploadObjectStore(store, options.maxUploadConcurrency ?? 4),
    importerStorage: store,
    managedHostingReport: { profile: backend, identityModel: "single-replit-managed-identity", providerPermissions: permissions, anonymousStatus: response.status, generationGuard: "ifGenerationMatch=0-and-pinned-read", nativeVersionRetentionVerified: false, applicationExposesListDeleteUpdate: false },
  };
}
