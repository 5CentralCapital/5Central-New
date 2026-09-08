-- A newly created recurring schedule starts at revision one and records its
-- creation in the same audit ledger; all other edits still require revision >1.
ALTER TABLE rent_ops_record_changes DROP CONSTRAINT IF EXISTS rent_ops_record_changes_revision_check;
ALTER TABLE rent_ops_record_changes ADD CONSTRAINT rent_ops_record_changes_revision_check
 CHECK (revision > 1 OR (revision = 1 AND entity_type = 'recurring_schedule'));
INSERT INTO rent_ops_schema_migrations(version,checksum_sha256) VALUES(17,'__RENT_OPS_V17_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version = 16 AND checksum_sha256 = '__RENT_OPS_V16_CHECKSUM__') AND EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version = 17 AND checksum_sha256 = '__RENT_OPS_V17_CHECKSUM__') THEN 1 ELSE 0 END;
