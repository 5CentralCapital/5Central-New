-- Preserve an exact tenant-account contact without inventing a tenancy link.
-- account_person_id retains its existing foreign key to rent_ops_people.
ALTER TABLE rent_ops_household_memberships DROP CONSTRAINT rent_ops_household_memberships_parent;
ALTER TABLE rent_ops_household_memberships ADD CONSTRAINT rent_ops_household_memberships_parent
 CHECK (tenancy_id IS NOT NULL OR application_id IS NOT NULL OR account_person_id IS NOT NULL);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (19, '__RENT_OPS_V19_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM rent_ops_schema_migrations WHERE version = 19 AND checksum_sha256 = '__RENT_OPS_V19_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v19_post_insert_checksum_guard;
