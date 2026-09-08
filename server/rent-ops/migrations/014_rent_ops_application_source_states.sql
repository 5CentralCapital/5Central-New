-- Preserve RM application progress independently from approval decisions.
ALTER TABLE rent_ops_applications DROP CONSTRAINT IF EXISTS rent_ops_applications_status_check;
ALTER TABLE rent_ops_applications ADD CONSTRAINT rent_ops_applications_status_check
  CHECK (status IS NULL OR status IN ('draft','submitted','missing_information','under_review','approved','declined','withdrawn','converted','complete','in_progress','awaiting_payment'));
ALTER TABLE rent_ops_application_history DROP CONSTRAINT IF EXISTS rent_ops_application_history_status_check;
ALTER TABLE rent_ops_application_history ADD CONSTRAINT rent_ops_application_history_status_check
  CHECK (status IS NULL OR status IN ('draft','submitted','missing_information','under_review','approved','declined','withdrawn','converted','complete','in_progress','awaiting_payment'));

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (14, '__RENT_OPS_V14_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 14 AND checksum_sha256 = '__RENT_OPS_V14_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v14_post_insert_checksum_guard;
