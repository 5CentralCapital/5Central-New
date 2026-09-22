-- Source credit applications refer to existing credits; they never create cash receipts.
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS credit_transaction_id varchar REFERENCES rent_ops_ledger_transactions(id);
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS credit_link_knowledge text;
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_allocation_kind_check;
ALTER TABLE rent_ops_payment_allocations ADD CONSTRAINT rent_ops_allocation_kind_check CHECK(kind IN ('allocation','reversal','transfer','credit_allocation'));
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_allocation_signed_source_check;
ALTER TABLE rent_ops_payment_allocations ADD CONSTRAINT rent_ops_allocation_signed_source_check CHECK (amount_knowledge IS NOT NULL AND (
 (kind='allocation' AND credit_transaction_id IS NULL AND ((amount_cents IS NULL AND amount_knowledge='unknown') OR (amount_cents>0 AND amount_knowledge='known')))
 OR (kind IN ('reversal','transfer','credit_allocation') AND ((kind='reversal' AND amount_cents<0) OR (kind IN ('transfer','credit_allocation') AND amount_cents>0)) AND amount_knowledge='known'
 AND source_system IS NOT NULL AND source_system='rent_manager' AND source_id IS NOT NULL
 AND source_artifact_sha256 IS NOT NULL AND source_artifact_sha256 ~ '^[a-f0-9]{64}$' AND artifact_observation_on IS NOT NULL
 AND ((kind='credit_allocation' AND payment_transaction_id IS NULL AND credit_transaction_id IS NOT NULL AND credit_link_knowledge IS NOT NULL AND credit_link_knowledge='exact')
 OR (kind<>'credit_allocation' AND credit_transaction_id IS NULL AND payment_transaction_id IS NOT NULL AND payment_link_knowledge='exact'))
 AND charge_transaction_id IS NOT NULL AND charge_link_knowledge='exact' AND allocated_on IS NOT NULL AND allocated_on_knowledge='source')
));
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256) VALUES (20, '__RENT_OPS_V20_CHECKSUM__') ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=20 AND checksum_sha256='__RENT_OPS_V20_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v20_post_insert_checksum_guard;
