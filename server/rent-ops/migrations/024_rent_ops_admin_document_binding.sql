-- Manager uploads are verified local facts, never applicant submissions or imports.
ALTER TABLE rent_ops_document_objects DROP CONSTRAINT IF EXISTS rent_ops_document_objects_binding_kind_check;
ALTER TABLE rent_ops_document_objects ADD CONSTRAINT rent_ops_document_objects_binding_kind_check CHECK (binding_kind IN ('applicant', 'import', 'admin'));
ALTER TABLE rent_ops_document_objects DROP CONSTRAINT IF EXISTS rent_ops_document_objects_binding_domain;
ALTER TABLE rent_ops_document_objects ADD CONSTRAINT rent_ops_document_objects_binding_domain CHECK (
  (binding_kind IN ('applicant', 'admin') AND source_binary_id IS NULL AND import_run_id IS NULL AND source_system IS NULL AND source_collection IS NULL)
  OR (binding_kind = 'import' AND source_binary_id IS NOT NULL AND import_run_id IS NOT NULL AND source_system IS NOT NULL AND source_collection IS NOT NULL)
);
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (24, '__RENT_OPS_V24_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=24 AND checksum_sha256='__RENT_OPS_V24_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v24_post_insert_checksum_guard;
