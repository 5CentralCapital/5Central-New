-- The verified RM Status field is an exact supported tenancy-status binding.
ALTER TABLE rent_ops_financial_semantic_crosswalks DROP CONSTRAINT rent_ops_financial_crosswalk_binding_check;
ALTER TABLE rent_ops_financial_semantic_crosswalks ADD CONSTRAINT rent_ops_financial_crosswalk_binding_check CHECK (
 (semantic_kind = 'tenancy_status' AND ((source_collection IN ('tenants.current','tenants.future','tenants.former') AND source_field = '$partition') OR (source_collection = 'tenants' AND source_field = 'Status')))
 OR (semantic_kind = 'charge_category' AND source_collection = 'chargeTypes' AND source_field = 'ChargeTypeID')
 OR (semantic_kind = 'charge_definition_active' AND source_collection = 'chargeTypes' AND source_field = 'IsActive')
 OR (semantic_kind = 'recurring_scope' AND source_collection = 'recurringSchedules' AND source_field = 'EntityType')
);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (21, '__RENT_OPS_V21_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM rent_ops_schema_migrations WHERE version = 21 AND checksum_sha256 = '__RENT_OPS_V21_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v21_post_insert_checksum_guard;
