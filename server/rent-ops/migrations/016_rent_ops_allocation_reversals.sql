-- Exact RM reverse allocations remain immutable source facts. Native writes
-- still admit only positive allocation amounts.
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'allocation';
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS source_artifact_sha256 text;
ALTER TABLE rent_ops_payment_allocations ADD COLUMN IF NOT EXISTS artifact_observation_on date;
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_allocation_amount_knowledge_v8_check;
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_payment_allocations_amount_cents_check;
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_allocation_amount_check;
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_allocation_kind_check;
ALTER TABLE rent_ops_payment_allocations ADD CONSTRAINT rent_ops_allocation_kind_check CHECK(kind IN ('allocation','reversal','transfer'));
ALTER TABLE rent_ops_payment_allocations DROP CONSTRAINT IF EXISTS rent_ops_allocation_signed_source_check;
ALTER TABLE rent_ops_payment_allocations ADD CONSTRAINT rent_ops_allocation_signed_source_check CHECK (amount_knowledge IS NOT NULL AND (
 (kind='allocation' AND ((amount_cents IS NULL AND amount_knowledge='unknown') OR (amount_cents>0 AND amount_knowledge='known')))
 OR (kind IN ('reversal','transfer') AND ((kind='reversal' AND amount_cents<0) OR (kind='transfer' AND amount_cents>0)) AND amount_knowledge='known'
   AND source_system IS NOT NULL AND source_system='rent_manager' AND source_id IS NOT NULL
   AND source_artifact_sha256 IS NOT NULL AND source_artifact_sha256 ~ '^[a-f0-9]{64}$'
   AND artifact_observation_on IS NOT NULL
   AND payment_transaction_id IS NOT NULL AND payment_link_knowledge='exact'
   AND charge_transaction_id IS NOT NULL AND charge_link_knowledge='exact'
   AND allocated_on IS NOT NULL AND allocated_on_knowledge='source')
));
DROP INDEX IF EXISTS rent_ops_allocations_payment_charge_unique;
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_allocations_native_payment_charge_unique ON rent_ops_payment_allocations(payment_transaction_id,charge_transaction_id) WHERE source_system IS NULL;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (16, '__RENT_OPS_V16_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM rent_ops_schema_migrations WHERE version=16 AND checksum_sha256='__RENT_OPS_V16_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v16_post_insert_checksum_guard;
