ALTER TABLE rent_ops_ledger_transactions ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS source_property_id varchar REFERENCES rent_ops_properties(id);
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (23, '__RENT_OPS_V23_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=23 AND checksum_sha256='__RENT_OPS_V23_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v23_post_insert_checksum_guard;
