-- Rent Operations v12: native, explicit monthly billing receipts.
-- Existing imported and manual ledger entries are never rewritten.

CREATE TABLE IF NOT EXISTS rent_ops_billing_charges (
  lineage_root_id varchar(160) NOT NULL REFERENCES rent_ops_recurring_charge_schedules(id),
  schedule_id varchar(160) NOT NULL REFERENCES rent_ops_recurring_charge_schedules(id),
  billing_on date NOT NULL CHECK (EXTRACT(DAY FROM billing_on) = 1),
  ledger_transaction_id varchar(160) NOT NULL UNIQUE REFERENCES rent_ops_ledger_transactions(id),
  tenancy_id varchar(160) NOT NULL REFERENCES rent_ops_tenancies(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  preview_token char(64) NOT NULL CHECK (preview_token ~ '^[a-f0-9]{64}$'),
  actor_subject text NOT NULL CHECK (length(btrim(actor_subject)) BETWEEN 1 AND 240),
  posted_at timestamptz NOT NULL,
  PRIMARY KEY (lineage_root_id, billing_on),
  UNIQUE (schedule_id, billing_on)
);

CREATE INDEX IF NOT EXISTS rent_ops_billing_charges_month_idx ON rent_ops_billing_charges(billing_on);

CREATE OR REPLACE FUNCTION rent_ops_guard_billing_charge()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'rent_ops_billing_charge_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rent_ops_ledger_transactions l
    JOIN rent_ops_recurring_charge_schedules s ON s.id = NEW.schedule_id
    WHERE l.id = NEW.ledger_transaction_id
      AND s.lineage_root_id = NEW.lineage_root_id
      AND l.tenancy_id = NEW.tenancy_id
      AND l.amount_cents = NEW.amount_cents
      AND s.amount_cents = NEW.amount_cents
      AND l.posted_on = NEW.billing_on AND l.due_on = NEW.billing_on
      AND l.kind = 'charge' AND l.status = 'posted'
      AND l.category IN ('base_rent', 'recurring_fee')
      AND l.category = s.category AND l.charge_definition_id = s.charge_definition_id
      AND l.source_system IS NULL AND l.source_id IS NULL
  ) THEN
    RAISE EXCEPTION 'rent_ops_billing_charge_ledger_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rent_ops_billing_charge_guard ON rent_ops_billing_charges;
CREATE TRIGGER rent_ops_billing_charge_guard BEFORE INSERT OR UPDATE OR DELETE
  ON rent_ops_billing_charges FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_billing_charge();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (12, '__RENT_OPS_V12_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 11 AND checksum_sha256 = '__RENT_OPS_V11_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 12 AND checksum_sha256 = '__RENT_OPS_V12_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v12_post_insert_checksum_guard;
