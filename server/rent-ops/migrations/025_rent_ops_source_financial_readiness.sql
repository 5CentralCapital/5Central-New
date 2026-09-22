-- Source-backed financial review flags contain no assumed subsidy obligation.
ALTER TABLE rent_ops_people ADD COLUMN payment_review_reason text;
ALTER TABLE rent_ops_people ADD COLUMN payment_review_artifact_sha256 varchar(64);
ALTER TABLE rent_ops_people ADD COLUMN payment_review_source_reference text;
ALTER TABLE rent_ops_people ADD CONSTRAINT rent_ops_people_payment_review_evidence CHECK (
 (payment_review_reason IS NULL AND payment_review_artifact_sha256 IS NULL AND payment_review_source_reference IS NULL)
 OR (payment_review_reason IS NOT NULL AND payment_review_reason = 'assistance_responsibility_unverified' AND payment_review_artifact_sha256 IS NOT NULL AND payment_review_artifact_sha256 ~ '^[a-f0-9]{64}$' AND payment_review_source_reference IS NOT NULL AND length(payment_review_source_reference) BETWEEN 1 AND 512)
);
-- Recorded source ledger transactions are distinct from bank settlement and due dates.
ALTER TABLE rent_ops_financial_semantic_crosswalks DROP CONSTRAINT rent_ops_financial_crosswalk_binding_check;
ALTER TABLE rent_ops_financial_semantic_crosswalks ADD CONSTRAINT rent_ops_financial_crosswalk_binding_check CHECK (
 (semantic_kind = 'tenancy_status' AND ((source_collection IN ('tenants.current','tenants.future','tenants.former') AND source_field = '$partition') OR (source_collection = 'tenants' AND source_field = 'Status')))
 OR (semantic_kind = 'charge_category' AND source_collection = 'chargeTypes' AND source_field = 'ChargeTypeID')
 OR (semantic_kind = 'charge_definition_active' AND source_collection = 'chargeTypes' AND source_field = 'IsActive')
 OR (semantic_kind = 'recurring_scope' AND source_collection = 'recurringSchedules' AND source_field = 'EntityType')
 OR (semantic_kind = 'ledger_status' AND source_collection IN ('charges','payments','credits') AND source_field = 'TransactionType')
);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (25, '__RENT_OPS_V25_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=25 AND checksum_sha256='__RENT_OPS_V25_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v25_post_insert_checksum_guard;
