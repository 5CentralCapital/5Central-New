import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
test("manager bindings permit no imported source identity and retain import requirements",async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE rent_ops_schema_migrations(version integer PRIMARY KEY,checksum_sha256 text); CREATE TABLE rent_ops_document_objects(binding_kind text CONSTRAINT rent_ops_document_objects_binding_kind_check CHECK(binding_kind IN ('applicant','import')),source_binary_id text,import_run_id text,source_system text,source_collection text);`);
 const sql=(await readFile(new URL("./024_rent_ops_admin_document_binding.sql",import.meta.url),"utf8")).replaceAll("__RENT_OPS_V24_CHECKSUM__","a".repeat(64));await db.exec(sql);await db.exec(sql);
 await db.query("INSERT INTO rent_ops_document_objects(binding_kind) VALUES ('admin')");
 await assert.rejects(db.query("INSERT INTO rent_ops_document_objects(binding_kind,source_binary_id) VALUES ('admin','invented-source')"));
 await assert.rejects(db.query("INSERT INTO rent_ops_document_objects(binding_kind) VALUES ('import')"));
 await assert.rejects(db.query("INSERT INTO rent_ops_document_objects(binding_kind) VALUES ('unknown')"));
 await db.query("INSERT INTO rent_ops_document_objects VALUES ('import','binary','run','rm','documents')");
 assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM rent_ops_document_objects")).rows[0].count,2);
 }finally{await db.close();}
});
