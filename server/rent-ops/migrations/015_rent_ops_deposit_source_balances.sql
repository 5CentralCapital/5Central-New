-- Preserve signed RM deposit summaries without claiming negative balances are held cash.
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS source_balance_cents integer;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN amount_held_cents DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits DROP CONSTRAINT IF EXISTS rent_ops_security_deposits_amount_held_cents_check;
ALTER TABLE rent_ops_security_deposits DROP CONSTRAINT IF EXISTS rent_ops_deposit_source_balance_check;
ALTER TABLE rent_ops_security_deposits ADD CONSTRAINT rent_ops_deposit_source_balance_check CHECK (
 (source_balance_cents IS NULL OR source_system IS NOT DISTINCT FROM 'rent_manager') AND (
 (amount_held_cents IS NOT NULL AND amount_held_cents >= 0)
 OR (amount_held_cents IS NULL AND source_system IS NOT DISTINCT FROM 'rent_manager' AND source_id IS NOT NULL AND source_balance_cents IS NOT NULL AND source_balance_cents < 0))
);
CREATE OR REPLACE FUNCTION rent_ops_guard_deposit_source_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_balance_cents IS DISTINCT FROM OLD.source_balance_cents THEN
  RAISE EXCEPTION 'imported deposit source balance is immutable';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS rent_ops_deposit_source_balance_guard ON rent_ops_security_deposits;
CREATE TRIGGER rent_ops_deposit_source_balance_guard BEFORE UPDATE ON rent_ops_security_deposits FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_deposit_source_balance();
INSERT INTO rent_ops_schema_migrations(version,checksum_sha256) VALUES (15,'__RENT_OPS_V15_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256 WHERE rent_ops_schema_migrations.checksum_sha256=EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 14 AND checksum_sha256 = '__RENT_OPS_V14_CHECKSUM__') AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 15 AND checksum_sha256 = '__RENT_OPS_V15_CHECKSUM__') THEN 1 ELSE 0 END;
