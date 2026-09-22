import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("./004_rent_ops_verified_documents.sql", import.meta.url);

test("verified document import bindings are exact source-binary bindings", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /source_binary_id varchar\(160\)/i);
  assert.match(sql, /import_run_id varchar\(160\)/i);
  assert.match(sql, /source_binary_id\) REFERENCES rent_ops_source_binaries\(id\)/i);
  assert.match(sql, /import_run_id\) REFERENCES rent_ops_import_runs\(id\)/i);
  assert.match(sql, /source_checksum IS DISTINCT FROM NEW\.checksum_sha256/i);
  assert.match(sql, /source_size IS DISTINCT FROM NEW\.size_bytes/i);
  assert.match(sql, /source_system_value IS DISTINCT FROM NEW\.source_system/i);
  assert.match(sql, /source_collection_value IS DISTINCT FROM NEW\.source_collection/i);
  assert.match(sql, /source_status IS DISTINCT FROM 'verified'/i);
  assert.match(sql, /binding_kind = 'applicant'.*source_binary_id IS NULL/is);
});

test("document-object indexing permits two document bindings to share one immutable object", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS rent_ops_document_objects_object_index/i);
  assert.doesNotMatch(sql, /UNIQUE\s+INDEX[^;]*rent_ops_document_objects_object_index/i);
});

test("verified availability constraint is repeatable on an exact migration rerun", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS rent_ops_documents_verified_availability/i);
  assert.match(sql, /ADD CONSTRAINT rent_ops_documents_verified_availability/i);
});
