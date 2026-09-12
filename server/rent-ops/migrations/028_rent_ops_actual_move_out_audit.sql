-- Restore the actual departure audit field removed by migration 008 while
-- preserving the complete current guard, including charge-definition limits.
DO $$
DECLARE prior_check text;
DECLARE updated_check text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO prior_check
    FROM pg_constraint
    WHERE conrelid = 'rent_ops_record_changes'::regclass
      AND conname = 'rent_ops_record_changes_changed_fields_check';
  IF prior_check IS NULL THEN RAISE EXCEPTION 'record change field guard missing'; END IF;
  updated_check := replace(prior_check, '''expectedMoveOutOn''::text', '''actualMoveOutOn''::text, ''expectedMoveOutOn''::text');
  IF updated_check = prior_check THEN RAISE EXCEPTION 'expected departure audit field guard missing'; END IF;
  ALTER TABLE rent_ops_record_changes DROP CONSTRAINT rent_ops_record_changes_changed_fields_check;
  EXECUTE 'ALTER TABLE rent_ops_record_changes ADD CONSTRAINT rent_ops_record_changes_changed_fields_check ' || updated_check;
END $$;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (28, '__RENT_OPS_V28_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=28 AND checksum_sha256='__RENT_OPS_V28_CHECKSUM__') THEN 1 ELSE 0 END;
