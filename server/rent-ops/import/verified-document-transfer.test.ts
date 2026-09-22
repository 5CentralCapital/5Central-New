import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { InMemoryObjectStore } from "../storage/object-store";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type { VerifiedDocumentArchiveInput } from "../services/service";
import { RentOpsService } from "../services/service";
import { ProductionRestrictedVerifiedDocumentTransfer } from "./verified-document-transfer";

function input(): VerifiedDocumentArchiveInput {
  const bytes = Buffer.from([0, 1, 2, 3]);
  return { documentId: "doc:test", type: "other", fileName: "private.bin", mimeType: "application/octet-stream", bytes, sizeBytes: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex"), sourceBinaryBinding: { bindingId: "binary:test", importRunId: "run:test", sourceSystem: "rent-manager", sourceCollection: "files" } };
}
function recorder(prior?: Record<string, unknown>) {
  const queries: string[] = [];
  const executor: RentOpsQueryExecutor = { async query<T>(sql: string) { queries.push(sql); return { rows: (sql.startsWith("SELECT") && prior ? [prior] : []) as T[] }; }, transaction: async () => { throw new Error("Nested transaction forbidden"); } };
  return { queries, executor };
}
test("transaction-only persistence preserves generic sensitive binary and exact source binding", async () => {
  const { queries, executor } = recorder();
  const result = await new ProductionRestrictedVerifiedDocumentTransfer(new InMemoryObjectStore()).transferVerifiedDocument(input(), executor);
  assert.equal(queries.length, 2);
  assert.match(queries[1], /^INSERT INTO rent_ops_documents/);
  assert.ok(queries.every(sql => !sql.includes("INSERT INTO rent_ops_document_objects")));
  assert.equal(result.document.mimeType, "application/octet-stream");
  assert.equal(result.binding.sourceBinaryId, "binary:test");
  assert.ok(result.binding.immutableGeneration);
  assert.ok(Date.now() - Date.parse(result.document.uploadedAt!) < 10_000);
});
test("exact replay retains persisted timestamp and rejects a changed immutable version", async () => {
  const store = new InMemoryObjectStore();
  const adapter = new ProductionRestrictedVerifiedDocumentTransfer(store);
  const first = await adapter.transferVerifiedDocument(input(), recorder().executor);
  const b = first.binding;
  const prior = { document_id: b.documentId, binding_kind: b.bindingKind, source_binary_id: b.sourceBinaryId, import_run_id: b.importRunId, source_system: b.sourceSystem, source_collection: b.sourceCollection, backend: b.backend, logical_key: b.logicalKey, checksum_sha256: b.checksumSha256, size_bytes: b.sizeBytes, immutable_generation: b.immutableGeneration, immutable_version: b.immutableVersion, verified_at: "2026-09-01T12:00:00.000Z", uploaded_at: "2026-09-01T11:59:59.000Z" };
  const replay = await adapter.transferVerifiedDocument(input(), recorder(prior).executor);
  assert.equal(replay.binding.verifiedAt, prior.verified_at);
  assert.equal(replay.document.uploadedAt, prior.uploaded_at);
  const conflict = recorder({ ...prior, immutable_generation: "wrong" });
  await assert.rejects(() => adapter.transferVerifiedDocument(input(), conflict.executor), /immutable binding conflict/);
  assert.equal(conflict.queries.length, 1);
});
test("source, filename, and verified-object mismatches fail before document writes", async () => {
  const store = new InMemoryObjectStore();
  const adapter = new ProductionRestrictedVerifiedDocumentTransfer(store);
  const tracked = recorder();
  await assert.rejects(() => adapter.transferVerifiedDocument({ ...input(), sizeBytes: 8 }, tracked.executor), /source binary/);
  await assert.rejects(() => adapter.transferVerifiedDocument({ ...input(), fileName: "../bad.bin" }, tracked.executor), /filename/);
  const original = store.stat.bind(store);
  store.stat = async (...args) => { const stat = await original(...args); return stat && { ...stat, immutableGeneration: "changed" }; };
  await assert.rejects(() => adapter.transferVerifiedDocument(input(), tracked.executor));
  assert.equal(tracked.queries.length, 0);
});
test("isolated PostgreSQL document write rolls back with caller transaction", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, query: sql => db.query(sql), executor: async sql => { await db.exec(sql); } });
    const adapter = new ProductionRestrictedVerifiedDocumentTransfer(new InMemoryObjectStore());
    await assert.rejects(() => db.transaction(async tx => {
      await adapter.transferVerifiedDocument(input(), { query: (sql, params) => tx.query(sql, params) });
      const inside = await tx.query("SELECT id FROM rent_ops_documents WHERE id = 'doc:test'");
      assert.equal(inside.rows.length, 1);
      throw new Error("intentional rollback");
    }), /intentional rollback/);
    assert.equal((await db.query("SELECT id FROM rent_ops_documents WHERE id = 'doc:test'")).rows.length, 0);
    assert.equal((await db.query("SELECT document_id FROM rent_ops_document_objects")).rows.length, 0);
  } finally { await db.close(); }
});

test("import preserves comma and ampersand filenames while rejecting paths and unsafe names", async () => {
 const adapter=new ProductionRestrictedVerifiedDocumentTransfer(new InMemoryObjectStore());
 const bytes=Buffer.from('%PDF-1.4\nsynthetic document\n%%EOF');
 const base={...input(),bytes,sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'application/pdf'};
 for(const fileName of ['Lease, Addendum.pdf','Lease & Addendum.pdf']){
  const result=await adapter.transferVerifiedDocument({...base,fileName},recorder().executor);
  assert.equal(result.document.fileName,fileName);assert.equal(result.document.checksumSha256,base.checksumSha256);
 }
 for(const fileName of ['', '../lease.pdf','folder/lease.pdf','folder\\lease.pdf','a..pdf','a\n.pdf','a\u0000.pdf','a\u007f.pdf','a'.repeat(241),'.hidden.pdf']){
  const tracked=recorder();await assert.rejects(adapter.transferVerifiedDocument({...base,fileName},tracked.executor),/filename/);assert.equal(tracked.queries.length,0);
 }
});

test("source-bound DOCX preserves MIME and bytes, while invalid content and normal uploads reject", async () => {
 const mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 const bytes=Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0]);
 const store=new InMemoryObjectStore();const adapter=new ProductionRestrictedVerifiedDocumentTransfer(store);
 const base={...input(),fileName:'Lease, Terms & Conditions.docx',mimeType,bytes,sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')};
 const result=await adapter.transferVerifiedDocument(base,recorder().executor);
 assert.equal(result.document.fileName,base.fileName);assert.equal(result.document.mimeType,mimeType);assert.equal(result.document.checksumSha256,base.checksumSha256);assert.equal(result.document.sizeBytes,bytes.length);assert.equal(result.binding.sourceBinaryId,base.sourceBinaryBinding.bindingId);
 const invalid=Buffer.from('not a ZIP');
 await assert.rejects(adapter.transferVerifiedDocument({...base,bytes:invalid,sizeBytes:invalid.length,checksumSha256:createHash('sha256').update(invalid).digest('hex')},recorder().executor),/content does not match/);
 await assert.rejects(adapter.transferVerifiedDocument({...base,mimeType:'application/pdf'},recorder().executor),/content does not match/);
 await assert.rejects(adapter.transferVerifiedDocument({...base,sourceBinaryBinding:{...base.sourceBinaryBinding,bindingId:''}},recorder().executor),/exact source binary/);
 const normal=new RentOpsService({} as never,undefined,undefined,undefined,false,{documentUploadStorage:store});
 await assert.rejects((normal as any).buildVerifiedDocument({...base,sourceBinaryBinding:undefined},{}),/content type is invalid/);
});
