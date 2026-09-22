import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import test, { afterEach } from "node:test";
import {
  StorageError,
  createImporterStorageFacade,
  createInMemoryObjectStore,
  createLocalStagingStore,
  createPrivateLocalStagingRoot,
  createRuntimeReadAdapter,
  PrivateVersionedObjectStoreAdapter,
  SpoolingPrivateVersionedObjectStoreAdapter,
  BoundedUploadObjectStore,
  createProductionRentOpsObjectStores,
  logicalKeyForChecksum,
  probePrivateObjectStorePrivileges,
  redactedStorageError,
  type SafeStorageLogger,
  type PrivateVersionedObjectStoreClient,
} from "./index";

const fixtures: string[] = [];

async function fixture(): Promise<{ base: string; repositoryRoot: string; root: string; sourceRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), "rent-ops-storage-"));
  fixtures.push(base);
  const repositoryRoot = join(base, "repository");
  const root = join(base, "private-storage");
  const sourceRoot = join(base, "source");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  await mkdir(sourceRoot, { mode: 0o700 });
  await chmod(repositoryRoot, 0o700);
  await chmod(root, 0o700);
  await chmod(sourceRoot, 0o700);
  return { base, repositoryRoot, root, sourceRoot };
}

async function privateFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectPath(root: string, checksum: string): string {
  return join(root, "objects", checksum.slice(0, 2), checksum);
}

async function streamBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(async () => {
  for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true });
});

test("content-addressed puts use only SHA-256 and publish an immutable verified object", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const bytes = Buffer.from("synthetic document bytes");
  const result = await store.putBytes(bytes, { sourceBinaryBinding: { sourceSystem: "synthetic", sourceCollection: "documents", sourceIdHash: "a".repeat(64) }, importRunId: "synthetic-run" });
  const checksum = digest(bytes);
  assert.equal(result.logicalKey, logicalKeyForChecksum(checksum));
  assert.equal(result.checksumSha256, checksum);
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.verificationState, "verified");
  assert.equal(result.outcome, "stored");
  assert.equal(result.created, true);
  assert.equal(JSON.stringify(result).includes("filename"), false);
  assert.equal(JSON.stringify(result).includes("synthetic document bytes"), false);
  assert.equal(JSON.stringify(result).includes("synthetic document"), false);
  const stat = await store.stat(result.logicalKey);
  assert.equal(stat?.sizeBytes, bytes.length);
  assert.equal((await streamBytes(await store.open(result.logicalKey))).toString(), bytes.toString());
  const rootStat = await lstat(root);
  const objectsStat = await lstat(join(root, "objects"));
  const stagingStat = await lstat(join(root, "staging"));
  const objectStat = await lstat(objectPath(root, checksum));
  assert.equal(rootStat.mode & 0o777, 0o700);
  assert.equal(objectsStat.mode & 0o777, 0o700);
  assert.equal(stagingStat.mode & 0o777, 0o700);
  assert.equal(objectStat.mode & 0o777, 0o600);
});

test("openVerified hashes and streams through one descriptor after pathname replacement", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const bytes = Buffer.from("same-descriptor verified payload");
  const result = await store.putBytes(bytes);
  const opened = await store.openVerified(result.logicalKey, { expectedSizeBytes: bytes.length });
  assert.equal(opened.verification.verificationState, "verified");
  assert.equal(opened.verification.checksumSha256, digest(bytes));

  const target = objectPath(root, result.checksumSha256);
  const replacement = join(root, "replacement.bin");
  await privateFile(replacement, Buffer.from("replacement after verification"));
  await unlink(target);
  await symlink(replacement, target);

  // A verify-then-open implementation would follow the replacement (or
  // reject the symlink); the returned stream remains bound to the verified fd.
  assert.deepEqual(await streamBytes(opened.stream), bytes);
});

test("source final component is no-follow, traversal is rejected, and hardlinks are refused", async () => {
  const { root, repositoryRoot, sourceRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot, sourceRoot });
  const source = join(sourceRoot, "source.bin");
  const alias = join(sourceRoot, "alias.bin");
  const outside = join((await fixture()).base, "outside.bin");
  await privateFile(source, Buffer.from("source"));
  await privateFile(outside, Buffer.from("outside"));
  await symlink(outside, join(sourceRoot, "symlink.bin"));
  await assert.rejects(() => store.putFile(join(sourceRoot, "..", "source.bin")), (error: unknown) => error instanceof StorageError && error.code === "storage_path_invalid");
  await assert.rejects(() => store.putFile(join(sourceRoot, "symlink.bin")), (error: unknown) => error instanceof StorageError && error.code === "storage_source_symlink");
  await mkdir(join(sourceRoot, "directory"), { mode: 0o700 });
  await assert.rejects(() => store.putFile(join(sourceRoot, "directory")), (error: unknown) => error instanceof StorageError && error.code === "storage_source_nonregular");
  await (await import("node:fs/promises")).link(source, alias);
  await assert.rejects(() => store.putFile(alias), (error: unknown) => error instanceof StorageError && error.code === "storage_source_hardlink");
  await unlink(alias);
});

test("source parent containment rejects a symlinked parent and a replacement race cannot redirect the descriptor", async () => {
  const { root, repositoryRoot, sourceRoot, base } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot, sourceRoot });
  const outsideDir = join(base, "outside-dir");
  const parentLink = join(sourceRoot, "parent-link");
  await mkdir(outsideDir, { mode: 0o700 });
  await privateFile(join(outsideDir, "source.bin"), Buffer.from("outside"));
  await symlink(outsideDir, parentLink);
  await assert.rejects(() => store.putFile(join(parentLink, "source.bin")), (error: unknown) => error instanceof StorageError && error.code === "storage_path_invalid");

  const source = join(sourceRoot, "race.bin");
  await privateFile(source, Buffer.alloc(256 * 1024, 7));
  // The adapter's descriptor read is synchronous from the caller's point of
  // view; this swap is best-effort and must either be rejected or leave the
  // original descriptor content, never follow the replacement symlink.
  const swap = (async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replacement = join(sourceRoot, "replacement.bin");
    await privateFile(replacement, Buffer.from("replacement"));
    await unlink(source).catch(() => undefined);
    await symlink(replacement, source).catch(() => undefined);
  })();
  const put = store.putFile(source);
  await Promise.allSettled([put, swap]);
  const sourceAfter = await lstat(source).catch(() => undefined);
  if (sourceAfter?.isSymbolicLink()) {
    await assert.rejects(() => store.putFile(source), (error: unknown) => error instanceof StorageError && error.code === "storage_source_symlink");
  }
});

test("empty, oversize, checksum, and size controls fail closed without leaving accepted objects", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot, maxBytes: 4 });
  await assert.rejects(() => store.putBytes(new Uint8Array()), (error: unknown) => error instanceof StorageError && error.code === "storage_empty");
  await assert.rejects(() => store.putBytes(Buffer.from("12345")), (error: unknown) => error instanceof StorageError && error.code === "storage_too_large");
  await assert.rejects(() => store.putBytes(Buffer.from("1234"), { expectedChecksumSha256: "a".repeat(64) }), (error: unknown) => error instanceof StorageError && error.code === "storage_checksum_mismatch");
  await assert.rejects(() => store.putBytes(Buffer.from("1234"), { expectedSizeBytes: 3 }), (error: unknown) => error instanceof StorageError && error.code === "storage_size_mismatch");
  assert.equal((await store.inventoryOrphans([])).objectCount, 0);
});

test("identical retry is a no-op and a same-key collision cannot overwrite the object", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const bytes = Buffer.from("immutable payload");
  const first = await store.putBytes(bytes);
  const second = await store.putBytes(bytes, { logicalKey: first.logicalKey, expectedChecksumSha256: first.checksumSha256, expectedSizeBytes: first.sizeBytes });
  assert.equal(second.outcome, "already_present");
  assert.equal(second.created, false);

  const target = objectPath(root, first.checksumSha256);
  await privateFile(target, Buffer.from("corrupt but same logical path"));
  await assert.rejects(() => store.putBytes(bytes, { logicalKey: first.logicalKey }), (error: unknown) => error instanceof StorageError && error.code === "storage_collision");
  assert.equal((await readFile(target)).toString(), "corrupt but same logical path");
});

test("destination symlink and interrupted temp names are never accepted", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const bytes = Buffer.from("destination payload");
  const checksum = digest(bytes);
  const shard = join(root, "objects", checksum.slice(0, 2));
  await mkdir(shard, { mode: 0o700 });
  await chmod(shard, 0o700);
  const outside = join(root, "outside");
  await privateFile(outside, bytes);
  await symlink(outside, objectPath(root, checksum));
  await assert.rejects(() => store.putBytes(bytes), (error: unknown) => error instanceof StorageError && error.code === "storage_destination_symlink");
  await assert.rejects(() => store.stat(logicalKeyForChecksum(checksum)), (error: unknown) => error instanceof StorageError && error.code === "storage_destination_symlink");
  await unlink(objectPath(root, checksum));
  await privateFile(join(root, "staging", ".object-interrupted.tmp"), bytes);
  assert.equal(await store.stat(logicalKeyForChecksum(checksum)), null);
});

test("concurrent puts converge on one immutable object and post-write reopen/rehash verifies it", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const bytes = Buffer.from("concurrent payload");
  const results = await Promise.all(Array.from({ length: 16 }, () => store.putBytes(bytes)));
  assert.equal(results.filter((result) => result.outcome === "stored").length, 1);
  assert.equal(results.filter((result) => result.outcome === "already_present").length, 15);
  const verified = await store.verify(results[0].logicalKey);
  assert.equal(verified.verificationState, "verified");
  assert.equal(verified.checksumSha256, digest(bytes));
});

test("root validation requires a private external directory and supports explicit provisioning", async () => {
  const { base, repositoryRoot } = await fixture();
  const inside = join(repositoryRoot, "storage");
  await mkdir(inside, { mode: 0o700 });
  await assert.rejects(() => createLocalStagingStore({ root: inside, repositoryRoot }), (error: unknown) => error instanceof StorageError && error.code === "storage_root_inside_repository");
  const permissive = join(base, "permissive");
  await mkdir(permissive, { mode: 0o755 });
  await assert.rejects(() => createLocalStagingStore({ root: permissive, repositoryRoot }), (error: unknown) => error instanceof StorageError && error.code === "storage_root_permissions");
  const linkRoot = join(base, "root-link");
  await symlink(permissive, linkRoot);
  await assert.rejects(() => createLocalStagingStore({ root: linkRoot, repositoryRoot }), (error: unknown) => error instanceof StorageError && error.code === "storage_root_symlink");
  const provisioned = join(base, "provisioned");
  const resolved = await createPrivateLocalStagingRoot({ root: provisioned, repositoryRoot });
  assert.equal((await lstat(resolved)).mode & 0o777, 0o700);
  await createLocalStagingStore({ root: resolved, repositoryRoot });
  await assert.rejects(() => createLocalStagingStore({ root: `${base}/../${base.split("/").pop()}`, repositoryRoot }), (error: unknown) => error instanceof StorageError && error.code === "storage_invalid_root");
});

test("error and logger output are stable and redacted", async () => {
  const { root, repositoryRoot, sourceRoot } = await fixture();
  const events: unknown[] = [];
  const logger: SafeStorageLogger = {
    info: (event, fields) => events.push({ event, fields }),
    warn: (event, fields) => events.push({ event, fields }),
  };
  const store = await createLocalStagingStore({ root, repositoryRoot, sourceRoot, logger });
  const filename = join(sourceRoot, "private-name-should-not-leak.pdf");
  await privateFile(filename, Buffer.from("safe"));
  const secretChecksum = "b".repeat(64);
  await assert.rejects(() => store.putFile(filename, { expectedChecksumSha256: secretChecksum }), (error: unknown) => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, "storage_checksum_mismatch");
    assert.equal(error.message.includes(filename), false);
    assert.equal(error.message.includes(secretChecksum), false);
    assert.deepEqual(redactedStorageError(error), { code: "storage_checksum_mismatch", retryable: false });
    return true;
  });
  const rendered = JSON.stringify(events);
  assert.equal(rendered.includes(filename), false);
  assert.equal(rendered.includes(secretChecksum), false);
});

test("runtime read adapter has no write/list/delete capability", async () => {
  const store = createInMemoryObjectStore();
  const adapter = createRuntimeReadAdapter(store);
  assert.deepEqual(Object.keys(adapter).sort(), ["backend", "open", "openVerified", "stat", "verify"]);
  assert.equal("putIfAbsent" in adapter, false);
  assert.equal("inventoryOrphans" in adapter, false);
  assert.equal("list" in adapter, false);
  assert.equal("write" in adapter, false);
  assert.equal("delete" in adapter, false);
});

test("in-memory object adapter contract preserves keys, versions, idempotency, and read verification", async () => {
  const store = createInMemoryObjectStore();
  const bytes = Buffer.from("object-store-neutral bytes");
  const first = await store.putIfAbsent({ bytes, sourceBinaryBinding: { bindingId: "binding-synthetic" }, importRunId: "run-synthetic" });
  const second = await store.putIfAbsent({ bytes, logicalKey: first.logicalKey });
  assert.equal(first.outcome, "stored");
  assert.equal(second.outcome, "already_present");
  assert.ok(first.immutableGeneration);
  assert.equal((await streamBytes(await store.open(first.logicalKey))).toString(), bytes.toString());
  assert.equal((await store.verify(first.logicalKey)).verificationState, "verified");
  const verifiedOpen = await store.openVerified(first.logicalKey);
  assert.equal(verifiedOpen.verification.verificationState, "verified");
  assert.equal((await streamBytes(verifiedOpen.stream)).toString(), bytes.toString());
  await assert.rejects(() => store.putIfAbsent({ bytes: Buffer.from("different"), logicalKey: first.logicalKey }), /storage_checksum_mismatch/);
});

test("orphan inventory is redacted and produces approval-gated compensating actions only", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const referenced = await store.putBytes(Buffer.from("referenced"));
  const orphan = await store.putBytes(Buffer.from("orphan"));
  const inventory = await store.inventoryOrphans([referenced.logicalKey]);
  assert.equal(inventory.objectCount, 2);
  assert.equal(inventory.orphanCount, 1);
  assert.equal(inventory.staleTempCount, 0);
  assert.equal(inventory.entries[0].logicalKey, orphan.logicalKey);
  const plan = store.planCompensatingCleanup(inventory);
  assert.equal(plan.destructiveDeletionImplemented, false);
  assert.equal(plan.actions[0].requiresApproval, true);
  assert.equal("delete" in store, false);
});

test("a crash-window linked temp remains readable and is inventoried with an unambiguous cleanup proof", async () => {
  const { root, repositoryRoot } = await fixture();
  const store = await createLocalStagingStore({ root, repositoryRoot });
  const first = await store.putBytes(Buffer.from("crash-window payload"));
  const tempPath = join(root, "staging", ".object-crash-window.tmp");
  await link(objectPath(root, first.checksumSha256), tempPath);

  assert.equal((await store.stat(first.logicalKey))?.sizeBytes, first.sizeBytes);
  assert.equal((await store.verify(first.logicalKey)).verificationState, "verified");
  const inventory = await store.inventoryOrphans([first.logicalKey]);
  assert.equal(inventory.orphanCount, 0);
  assert.equal(inventory.staleTempCount, 1);
  assert.equal(inventory.staleTemps[0]?.classification, "published_linked_temp");
  assert.equal(inventory.staleTemps[0]?.sameObjectIdentity, true);
  assert.equal(inventory.staleTemps[0]?.safeToRemove, true);
  assert.equal(inventory.staleTemps[0]?.tempToken.includes("crash-window"), false);
  const plan = store.planCompensatingCleanup(inventory);
  const tempAction = plan.actions.find((action) => "tempToken" in action);
  assert.equal(tempAction?.action, "remove_stale_temp");
  assert.equal(tempAction?.safeToRemove, true);
  assert.equal("crash-window" in tempAction!, false);

  // The core only plans cleanup; an approved external cleanup can remove the
  // exact private temp, after which the object remains a normal nlink=1 file.
  await unlink(tempPath);
  assert.equal((await store.verify(first.logicalKey)).verificationState, "verified");
  assert.equal((await store.inventoryOrphans([first.logicalKey])).staleTempCount, 0);
});

test("RM importer facade requires a configured source root and cannot write arbitrary absolute files", async () => {
  const { root, repositoryRoot, sourceRoot, base } = await fixture();
  const source = join(sourceRoot, "rm-export.bin");
  const outside = join(base, "private-unrelated.bin");
  await privateFile(source, Buffer.from("synthetic RM export binary"));
  await privateFile(outside, Buffer.from("unrelated private binary"));
  const store = await createLocalStagingStore({ root, repositoryRoot, sourceRoot });
  const importer = await createImporterStorageFacade(store, { sourceRoot });
  const stored = await importer.putFile(source);
  assert.equal(stored.verificationState, "verified");
  assert.equal("putIfAbsent" in importer, false);
  assert.equal("sourceRoot" in importer, false);
  await assert.rejects(() => importer.putFile(outside), (error: unknown) => error instanceof StorageError && error.code === "storage_path_invalid");
  await assert.rejects(() => importer.putFile(source, { sourceRoot: base }), (error: unknown) => error instanceof StorageError && error.code === "storage_import_source_root_mismatch");

  const secondRoot = join(base, "second-storage");
  await mkdir(secondRoot, { mode: 0o700 });
  await chmod(secondRoot, 0o700);
  const unrestrictedStore = await createLocalStagingStore({ root: secondRoot, repositoryRoot });
  await assert.rejects(() => createImporterStorageFacade(unrestrictedStore, { sourceRoot }), (error: unknown) => error instanceof StorageError && error.code === "storage_import_source_root_required");
});

test("private versioned privilege probe separates runtime and importer identities and scopes required operations", async () => {
  let calls = 0;
  const report = await probePrivateObjectStorePrivileges({
    async probe() {
      calls += 1;
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.runtime.privileges.head, true);
  assert.equal(report.runtime.privileges.put, false);
  assert.equal(report.importer.privileges.put, true);
  assert.equal(report.importer.privileges.delete, false);
  const uploadReport = await probePrivateObjectStorePrivileges({
    requireUploadWriter: true,
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: false, delete: false } },
        uploadWriter: { identity: "web-upload-writer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  });
  assert.equal(uploadReport.uploadWriter?.identity, "web-upload-writer");
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    requireUploadWriter: true,
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, write: true, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: false, put: false, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: true, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: false, delete: true } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: true, delete: false } },
      };
    },
  }), /storage_privilege_probe_failed/);
  await assert.rejects(() => probePrivateObjectStorePrivileges({
    async probe() {
      return {
        privateOnly: true,
        versioningEnabled: true,
        runtime: { identity: "web-runtime", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: false, list: false, delete: false } },
        importer: { identity: "rm-importer", prefix: "rent-ops/documents", privileges: { get: true, head: true, put: true, list: false, delete: true } },
      };
    },
  }), /storage_privilege_probe_failed/);
});

test("remote adapter requires one exact immutable version across stat, verify, and open", async () => {
  const bytes = Buffer.from("remote immutable bytes");
  const checksum = digest(bytes);
  const key = logicalKeyForChecksum(checksum);
  const seen: Array<{ operation: string; generation?: string }> = [];
  const client: PrivateVersionedObjectStoreClient = {
    async putIfAbsent() { return { existed: false, immutableGeneration: "generation-a" }; },
    async stat(logicalKey, options) { seen.push({ operation: `stat:${logicalKey}`, generation: options?.immutableGeneration }); return { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-a" }; },
    async open(logicalKey, options) { seen.push({ operation: `open:${logicalKey}`, generation: options?.immutableGeneration }); return Readable.from([bytes]); },
    async verify(logicalKey, options) { seen.push({ operation: `verify:${logicalKey}`, generation: options?.immutableGeneration }); return { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-a", verificationState: "verified", verifiedAt: "2026-08-17T00:00:00.000Z" }; },
    async openVerified(logicalKey, options) { seen.push({ operation: `openVerified:${logicalKey}`, generation: options?.immutableGeneration }); return { stream: Readable.from([bytes]), verification: { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-a", verificationState: "verified", verifiedAt: "2026-08-17T00:00:00.000Z" } }; },
  };
  const adapter = new PrivateVersionedObjectStoreAdapter(client);
  const stored = await adapter.putIfAbsent({ bytes });
  assert.equal(stored.immutableGeneration, "generation-a");
  assert.equal(seen.find((entry) => entry.operation.startsWith("verify:"))?.generation, "generation-a");
  await adapter.stat(key, { immutableGeneration: "generation-a" });
  await adapter.verify(key, { immutableGeneration: "generation-a" });
  await adapter.open(key, { immutableGeneration: "generation-a" });
  await adapter.openVerified(key, { immutableGeneration: "generation-a" });
  assert.ok(seen.filter((entry) => entry.generation === "generation-a").length >= 5);
  await assert.rejects(() => adapter.openVerified(key, { immutableGeneration: "generation-b" }), /storage_version_mismatch/);
  await assert.rejects(() => adapter.open(key), /storage_version_missing/);
  const missingVersionClient: PrivateVersionedObjectStoreClient = { ...client, async putIfAbsent() { return { existed: false }; } };
  await assert.rejects(() => new PrivateVersionedObjectStoreAdapter(missingVersionClient).putIfAbsent({ bytes }), /storage_version_missing/);
});

test("bounded upload admission rejects saturation before consuming a body", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let consumed = 0;
  const store = new BoundedUploadObjectStore({
    backend: "private-versioned-object-store",
    async putIfAbsent(input) {
      for await (const chunk of input.stream ?? []) consumed += Buffer.from(chunk).length;
      await hold;
      return { backend: "private-versioned-object-store", logicalKey: logicalKeyForChecksum(digest(Buffer.from("a"))), checksumSha256: digest(Buffer.from("a")), sizeBytes: 1, verificationState: "verified", outcome: "stored", created: true, immutableGeneration: "g" };
    },
    async stat() { return null; },
    async open() { return Readable.from([]); },
    async verify() { throw new Error("not used"); },
    async openVerified() { throw new Error("not used"); },
  }, 1);
  const first = store.putIfAbsent({ stream: Readable.from([Buffer.from("a")]) });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => store.putIfAbsent({ stream: Readable.from([Buffer.from("b")]) }), (error: unknown) => error instanceof StorageError && error.code === "storage_busy" && error.retryable);
  assert.equal(consumed, 1);
  release();
  await first;
  assert.equal(store.activeUploads, 0);
});

test("production object-store factory binds distinct identities and exposes runtime Head/Get only", async () => {
  const bytes = Buffer.from("factory payload");
  const checksum = digest(bytes);
  const client: PrivateVersionedObjectStoreClient = {
    async putIfAbsent() { return { existed: false, immutableGeneration: "generation-a" }; },
    async stat(logicalKey) { return { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-a" }; },
    async open() { return Readable.from([bytes]); },
    async verify(logicalKey) { return { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-a", verificationState: "verified" as const }; },
    async openVerified(logicalKey) { return { stream: Readable.from([bytes]), verification: { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-a", verificationState: "verified" as const } }; },
  };
  const stores = await createProductionRentOpsObjectStores({
    env: {
      RENT_OPS_OBJECT_STORE_BACKEND: "private-versioned",
      RENT_OPS_OBJECT_STORE_ENCRYPTION: "required",
      RENT_OPS_OBJECT_STORE_VERSIONING: "required",
      RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY: "runtime-get",
      RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY: "applicant-upload",
      RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY: "restricted-importer",
    },
    clients: { runtime: client, applicantUpload: client, importer: client },
    privilegeProbe: {
      async probe() {
        return {
          privateOnly: true,
          versioningEnabled: true,
          runtime: { identity: "runtime-get", prefix: "rent-ops/private", privileges: { get: true, head: true, put: false, list: false, delete: false } },
          uploadWriter: { identity: "applicant-upload", prefix: "rent-ops/private", privileges: { get: true, head: true, put: true, list: false, delete: false } },
          importer: { identity: "restricted-importer", prefix: "rent-ops/private", privileges: { get: true, head: true, put: true, list: false, delete: false } },
        };
      },
    },
  });
  assert.equal("putIfAbsent" in stores.documentStorage, false);
  assert.equal(stores.privilegeReport.runtime.privileges.put, false);
  assert.equal(stores.privilegeReport.uploadWriter?.privileges.put, true);
  assert.equal(stores.privilegeReport.importer.privileges.delete, false);
});

test("production provider adapter uses a private no-follow spool and leaves no body temp", async () => {
  const { base } = await fixture();
  const spoolRoot = join(base, "spool");
  const bytes = Buffer.from("spooled without a giant request buffer");
  const checksum = digest(bytes);
  const key = logicalKeyForChecksum(checksum);
  let uploaded = Buffer.alloc(0);
  const client: PrivateVersionedObjectStoreClient = {
    async putIfAbsent(input) {
      for await (const chunk of input.body) uploaded = Buffer.concat([uploaded, Buffer.from(chunk)]);
      return { existed: false, immutableGeneration: "generation-spooled" };
    },
    async stat(logicalKey) { return { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-spooled" }; },
    async open(logicalKey) { return Readable.from([bytes]); },
    async verify(logicalKey) { return { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-spooled", verificationState: "verified" as const }; },
    async openVerified(logicalKey) { return { stream: Readable.from([bytes]), verification: { backend: "private-versioned-object-store", logicalKey, checksumSha256: checksum, sizeBytes: bytes.length, immutableGeneration: "generation-spooled", verificationState: "verified" as const } }; },
  };
  const adapter = new SpoolingPrivateVersionedObjectStoreAdapter(client, { spoolRoot });
  const result = await adapter.putIfAbsent({ stream: Readable.from([bytes]), expectedChecksumSha256: checksum, expectedSizeBytes: bytes.length, logicalKey: key });
  assert.equal(result.verificationState, "verified");
  assert.deepEqual(uploaded, bytes);
  assert.deepEqual(await readdir(spoolRoot), []);
});

test("local staging and configured import roots must be disjoint", async () => {
  const { root, repositoryRoot, sourceRoot } = await fixture();
  await assert.rejects(() => createLocalStagingStore({ root, repositoryRoot, sourceRoot: join(root, "source") }), /storage_path_invalid|storage_roots_overlap/);
  await assert.rejects(() => createLocalStagingStore({ root: sourceRoot, repositoryRoot, sourceRoot }), /storage_roots_overlap/);
});
