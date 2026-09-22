-- Tenant Checkout attempts and processor receipts. No provider credentials,
-- card/bank data, or complete webhook payloads are stored in these tables.
CREATE TABLE IF NOT EXISTS rent_ops_tenant_payments (
  id varchar(160) PRIMARY KEY,
  account_id varchar(160) NOT NULL,
  person_id varchar(160) NOT NULL REFERENCES rent_ops_people(id),
  tenancy_id varchar(160) NOT NULL REFERENCES rent_ops_tenancies(id),
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160) NOT NULL REFERENCES rent_ops_units(id),
  request_id uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 50 AND 99999999),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status text NOT NULL CHECK (status IN ('creating','pending','processing','posted','failed','cancelled','partially_refunded','refunded','disputed','review_required')),
  checkout_session_id text UNIQUE,
  payment_intent_id text UNIQUE,
  checkout_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  posted_on date,
  current_ledger_id varchar(160) REFERENCES rent_ops_ledger_transactions(id),
  current_ledger_cents integer NOT NULL DEFAULT 0 CHECK (current_ledger_cents >= 0 AND current_ledger_cents <= amount_cents),
  ledger_revision integer NOT NULL DEFAULT 0 CHECK (ledger_revision >= 0),
  CONSTRAINT rent_ops_tenant_payments_request_unique UNIQUE (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS rent_ops_tenant_payments_tenancy_index ON rent_ops_tenant_payments(tenancy_id, created_at);

CREATE TABLE IF NOT EXISTS rent_ops_payment_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  payment_id varchar(160) REFERENCES rent_ops_tenant_payments(id),
  provider_created_at bigint NOT NULL CHECK (provider_created_at > 0),
  outcome text NOT NULL CHECK (outcome IN ('processed','ignored','review_required')),
  received_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rent_ops_payment_adjustments (
  payment_id varchar(160) NOT NULL REFERENCES rent_ops_tenant_payments(id),
  provider_object_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('refund','dispute')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  active boolean NOT NULL,
  provider_created_at bigint NOT NULL CHECK (provider_created_at > 0),
  terminal boolean NOT NULL DEFAULT false,
  PRIMARY KEY(payment_id, provider_object_id)
);

CREATE OR REPLACE FUNCTION rent_ops_payment_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Processor event receipts are immutable'; END;
$$;
DROP TRIGGER IF EXISTS rent_ops_payment_events_immutable_trigger ON rent_ops_payment_events;
CREATE TRIGGER rent_ops_payment_events_immutable_trigger BEFORE UPDATE OR DELETE ON rent_ops_payment_events FOR EACH ROW EXECUTE FUNCTION rent_ops_payment_events_immutable();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (11, '__RENT_OPS_V11_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 11 AND checksum_sha256 = '__RENT_OPS_V11_CHECKSUM__') THEN 1 ELSE 0 END AS rent_ops_v11_post_insert_checksum_guard;
