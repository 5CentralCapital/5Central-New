-- Unknown source presentation types remain explicit while answer values stay restricted.
ALTER TABLE rent_ops_application_template_fields DROP CONSTRAINT IF EXISTS rent_ops_application_template_fields_value_type_check;
ALTER TABLE rent_ops_application_template_fields ADD CONSTRAINT rent_ops_application_template_fields_value_type_check
 CHECK (value_type IS NULL OR value_type IN ('unknown','text','integer','decimal','boolean','date','choice','multi_choice','money'));
ALTER TABLE rent_ops_application_answer_occurrences DROP CONSTRAINT IF EXISTS rent_ops_application_answer_occurrences_value_type_check;
ALTER TABLE rent_ops_application_answer_occurrences ADD CONSTRAINT rent_ops_application_answer_occurrences_value_type_check
 CHECK (value_type IN ('unknown','text','integer','decimal','boolean','date','choice','multi_choice','money'));

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (18, '__RENT_OPS_V18_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM rent_ops_schema_migrations WHERE version = 18 AND checksum_sha256 = '__RENT_OPS_V18_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v18_post_insert_checksum_guard;
