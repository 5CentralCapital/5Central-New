-- Preserve the existing 162-character generated identity without truncation.
ALTER TABLE rent_ops_restricted_parity_collection_occurrences ALTER COLUMN id TYPE varchar(192);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (22, '__RENT_OPS_V22_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM rent_ops_schema_migrations WHERE version = 22 AND checksum_sha256 = '__RENT_OPS_V22_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v22_post_insert_checksum_guard;
