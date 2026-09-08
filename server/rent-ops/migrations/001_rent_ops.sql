-- Rent Operations schema v1. This file is intentionally not executed by boot.
-- Apply it only through ensureRentOpsSchema({ apply: true, executor }) after
-- a reviewed backup. Every money column is integer cents.
-- The checksum token is replaced by persistence.ts at apply time. It hashes
-- this exact source, so changing this file after v1 is applied fails closed.

CREATE TABLE IF NOT EXISTS rent_ops_schema_meta (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum_sha256 varchar(64),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_schema_meta_checksum_format CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE rent_ops_schema_meta ADD COLUMN IF NOT EXISTS checksum_sha256 varchar(64);
SELECT 1 / CASE WHEN NOT EXISTS (SELECT 1 FROM rent_ops_schema_meta WHERE version > 1) AND (NOT EXISTS (SELECT 1 FROM rent_ops_schema_meta WHERE version = 1) OR EXISTS (SELECT 1 FROM rent_ops_schema_meta WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')) THEN 1 ELSE 0 END AS rent_ops_schema_checksum_guard;

CREATE TABLE IF NOT EXISTS rent_ops_properties (
  id varchar(160) PRIMARY KEY,
  name text NOT NULL,
  slug varchar(120) NOT NULL UNIQUE,
  address_line1 text NOT NULL,
  address_line2 text,
  city text NOT NULL,
  state varchar(2) NOT NULL CHECK (length(state) = 2),
  postal_code varchar(20) NOT NULL,
  property_type text NOT NULL CHECK (property_type IN ('multifamily', 'single_family', 'other')),
  state_status text NOT NULL DEFAULT 'active' CHECK (state_status IN ('active', 'archived')),
  operating_contact text,
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_properties_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_units (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_number varchar(80) NOT NULL,
  unit_type text,
  bedrooms integer CHECK (bedrooms IS NULL OR bedrooms >= 0),
  bathrooms real CHECK (bathrooms IS NULL OR bathrooms >= 0),
  square_feet integer CHECK (square_feet IS NULL OR square_feet >= 0),
  market_rent_cents integer CHECK (market_rent_cents IS NULL OR market_rent_cents >= 0),
  default_deposit_cents integer CHECK (default_deposit_cents IS NULL OR default_deposit_cents >= 0),
  readiness text NOT NULL DEFAULT 'not_ready' CHECK (readiness IN ('ready', 'not_ready', 'off_market')),
  listing text NOT NULL DEFAULT 'unlisted' CHECK (listing IN ('listed', 'unlisted', 'off_market')),
  amenities jsonb,
  access_notes text,
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id, unit_number),
  CONSTRAINT rent_ops_units_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_people (
  id varchar(160) PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,
  phone text,
  renter_insurance_expires_on date,
  archived boolean NOT NULL DEFAULT false,
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_people_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_tenancies (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160) NOT NULL REFERENCES rent_ops_units(id),
  primary_person_id varchar(160) NOT NULL REFERENCES rent_ops_people(id),
  status text NOT NULL CHECK (status IN ('future', 'current', 'notice', 'past', 'cancelled')),
  actual_move_in_on date,
  notice_on date,
  expected_move_out_on date,
  actual_move_out_on date,
  application_id varchar(160),
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT rent_ops_tenancies_date_order CHECK (actual_move_out_on IS NULL OR actual_move_in_on IS NULL OR actual_move_out_on >= actual_move_in_on),
  CONSTRAINT rent_ops_tenancies_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_household_memberships (
  id varchar(160) PRIMARY KEY,
  tenancy_id varchar(160),
  application_id varchar(160),
  person_id varchar(160) NOT NULL REFERENCES rent_ops_people(id),
  role text NOT NULL CHECK (role IN ('primary', 'co_applicant', 'occupant', 'minor', 'emergency_contact', 'other_contact')),
  relationship text,
  is_financially_responsible boolean NOT NULL DEFAULT false,
  CONSTRAINT rent_ops_household_memberships_parent CHECK (tenancy_id IS NOT NULL OR application_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS rent_ops_lease_terms (
  id varchar(160) PRIMARY KEY,
  tenancy_id varchar(160) NOT NULL REFERENCES rent_ops_tenancies(id),
  status text NOT NULL CHECK (status IN ('draft', 'executed', 'expired', 'month_to_month', 'cancelled')),
  contract_start_on date NOT NULL,
  contract_end_on date,
  month_to_month boolean NOT NULL DEFAULT false,
  signed_on date,
  executed_document_id varchar(160),
  renewal_of_id varchar(160),
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL,
  CONSTRAINT rent_ops_lease_terms_date_order CHECK (contract_end_on IS NULL OR contract_end_on >= contract_start_on),
  CONSTRAINT rent_ops_lease_terms_mtm_date CHECK (month_to_month OR contract_end_on IS NOT NULL),
  CONSTRAINT rent_ops_lease_terms_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_recurring_charge_schedules (
  id varchar(160) PRIMARY KEY,
  tenancy_id varchar(160) NOT NULL REFERENCES rent_ops_tenancies(id),
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160) NOT NULL REFERENCES rent_ops_units(id),
  category text NOT NULL CHECK (category IN ('base_rent', 'recurring_fee', 'one_time_fee', 'subsidy', 'security_deposit', 'refundable_pet_deposit', 'move_in_funds', 'unapplied_cash', 'other')),
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  effective_from date NOT NULL,
  effective_to date,
  active boolean NOT NULL DEFAULT true,
  source_confidence text CHECK (source_confidence IS NULL OR source_confidence IN ('confirmed', 'inferred', 'exception')),
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_schedules_date_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT rent_ops_schedules_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_ledger_transactions (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160),
  tenancy_id varchar(160),
  person_id varchar(160),
  kind text NOT NULL CHECK (kind IN ('charge', 'payment', 'credit', 'reversal', 'adjustment')),
  category text NOT NULL CHECK (category IN ('base_rent', 'recurring_fee', 'one_time_fee', 'subsidy', 'security_deposit', 'refundable_pet_deposit', 'move_in_funds', 'unapplied_cash', 'other')),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided', 'pending')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  posted_on date NOT NULL,
  due_on date,
  payment_method text,
  description text NOT NULL,
  reversal_of_id varchar(160),
  payer text CHECK (payer IS NULL OR payer IN ('tenant', 'agency', 'owner', 'unknown')),
  adjustment_direction text CHECK (adjustment_direction IS NULL OR adjustment_direction IN ('debit', 'credit')),
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_ledger_reversal_link CHECK (kind <> 'reversal' OR reversal_of_id IS NOT NULL),
  CONSTRAINT rent_ops_ledger_adjustment_direction CHECK ((kind = 'adjustment') = (adjustment_direction IS NOT NULL)),
  CONSTRAINT rent_ops_ledger_reversal_status CHECK (kind <> 'reversal' OR status = 'posted'),
  CONSTRAINT rent_ops_ledger_date_order CHECK (due_on IS NULL OR due_on >= posted_on),
  CONSTRAINT rent_ops_ledger_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_payment_allocations (
  id varchar(160) PRIMARY KEY,
  payment_transaction_id varchar(160) NOT NULL REFERENCES rent_ops_ledger_transactions(id),
  charge_transaction_id varchar(160) NOT NULL REFERENCES rent_ops_ledger_transactions(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  allocated_on date NOT NULL,
  source_system text,
  source_id text,
  CONSTRAINT rent_ops_allocations_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_security_deposits (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160) NOT NULL REFERENCES rent_ops_units(id),
  tenancy_id varchar(160) NOT NULL REFERENCES rent_ops_tenancies(id),
  person_id varchar(160) NOT NULL REFERENCES rent_ops_people(id),
  type text NOT NULL CHECK (type IN ('security', 'refundable_pet', 'other_refundable')),
  amount_held_cents integer NOT NULL CHECK (amount_held_cents > 0),
  received_on date NOT NULL,
  disposition_status text NOT NULL DEFAULT 'held' CHECK (disposition_status IN ('held', 'partially_disposed', 'disposed', 'returned')),
  disposed_on date,
  disposition_notes text,
  source_system text,
  source_id text,
  CONSTRAINT rent_ops_deposits_disposition_date CHECK ((disposition_status = 'held' AND disposed_on IS NULL) OR (disposition_status <> 'held' AND disposed_on IS NOT NULL AND disposed_on >= received_on)),
  CONSTRAINT rent_ops_deposits_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_subsidy_contracts (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160) NOT NULL REFERENCES rent_ops_units(id),
  tenancy_id varchar(160) NOT NULL REFERENCES rent_ops_tenancies(id),
  agency_name text NOT NULL,
  contract_number text,
  effective_from date NOT NULL,
  effective_to date,
  agency_obligation_cents integer NOT NULL CHECK (agency_obligation_cents >= 0),
  tenant_obligation_cents integer NOT NULL CHECK (tenant_obligation_cents >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'pending', 'exception')),
  source_system text,
  source_id text,
  CONSTRAINT rent_ops_subsidy_positive_obligation CHECK (agency_obligation_cents + tenant_obligation_cents > 0),
  CONSTRAINT rent_ops_subsidy_date_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT rent_ops_subsidy_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_applications (
  id varchar(160) PRIMARY KEY,
  source_type text NOT NULL DEFAULT 'public_portal' CHECK (source_type IN ('public_portal', 'manual', 'rm_import', 'referral', 'other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'missing_information', 'under_review', 'approved', 'declined', 'withdrawn', 'converted')),
  email text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text,
  property_id varchar(160),
  unit_id varchar(160),
  submitted_on date,
  certification_accepted_on date,
  resume_token_hash text UNIQUE,
  resume_token_expires_at timestamptz,
  converted_tenancy_id varchar(160),
  rental_history jsonb,
  employment jsonb,
  household_summary jsonb,
  preferences jsonb,
  voucher jsonb,
  pets jsonb,
  vehicles jsonb,
  emergency_contact jsonb,
  source_system text,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_applications_date_order CHECK (certification_accepted_on IS NULL OR submitted_on IS NULL OR certification_accepted_on <= submitted_on),
  CONSTRAINT rent_ops_applications_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_application_household_members (
  id varchar(160) PRIMARY KEY,
  application_id varchar(160) NOT NULL REFERENCES rent_ops_applications(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  relationship text,
  email text,
  phone text,
  is_minor boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS rent_ops_application_requirements (
  id varchar(160) PRIMARY KEY,
  application_id varchar(160) NOT NULL REFERENCES rent_ops_applications(id),
  key varchar(120) NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'received', 'waived', 'rejected')),
  document_id varchar(160),
  requested_on date NOT NULL,
  resolved_on date,
  UNIQUE(application_id, key),
  CONSTRAINT rent_ops_application_requirements_date_order CHECK (resolved_on IS NULL OR resolved_on >= requested_on)
);

CREATE TABLE IF NOT EXISTS rent_ops_documents (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  unit_id varchar(160) REFERENCES rent_ops_units(id),
  person_id varchar(160) REFERENCES rent_ops_people(id),
  tenancy_id varchar(160) REFERENCES rent_ops_tenancies(id),
  application_id varchar(160) REFERENCES rent_ops_applications(id),
  type text NOT NULL CHECK (type IN ('lease', 'addendum', 'identity', 'insurance', 'notice', 'application_attachment', 'housing_assistance', 'deposit_record', 'other')),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'received', 'signed', 'executed', 'filed', 'current', 'verified', 'rejected', 'expired', 'archived')),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 varchar(64) CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  storage_key text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  source_system text,
  source_id text,
  CONSTRAINT rent_ops_documents_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_activity_events (
  id varchar(160) PRIMARY KEY,
  property_id varchar(160),
  unit_id varchar(160),
  person_id varchar(160),
  tenancy_id varchar(160),
  application_id varchar(160),
  type text NOT NULL CHECK (type IN ('note', 'call', 'email', 'text', 'promise_to_pay', 'hold', 'notice', 'system')),
  occurred_at timestamptz NOT NULL,
  actor text NOT NULL,
  summary text NOT NULL,
  detail text,
  source_system text,
  source_id text,
  metadata jsonb,
  CONSTRAINT rent_ops_activity_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_source_records (
  id varchar(160) PRIMARY KEY,
  system text NOT NULL,
  entity_type text NOT NULL,
  source_id text NOT NULL CHECK (length(trim(source_id)) > 0),
  source_updated_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  checksum varchar(128) CHECK (checksum IS NULL OR checksum ~ '^[0-9a-fA-F]{64}$'),
  target_id varchar(160) NOT NULL,
  raw_metadata jsonb,
  UNIQUE(system, entity_type, source_id)
);

CREATE TABLE IF NOT EXISTS rent_ops_import_runs (
  id varchar(160) PRIMARY KEY,
  system text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  mode text NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  source_manifest_hash varchar(128),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT rent_ops_import_runs_date_order CHECK (completed_at IS NULL OR completed_at >= started_at)
);

-- Lossless source payloads are deliberately separate from normal source
-- metadata. Application repositories and routes never select this table.
CREATE TABLE IF NOT EXISTS rent_ops_source_payloads (
  id varchar(160) PRIMARY KEY,
  system text NOT NULL,
  source_collection text NOT NULL CHECK (length(trim(source_collection)) > 0),
  source_id text NOT NULL CHECK (length(trim(source_id)) > 0),
  source_updated_at timestamptz,
  payload jsonb NOT NULL,
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  import_run_id varchar(160) NOT NULL REFERENCES rent_ops_import_runs(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(system, source_collection, source_id, checksum_sha256)
);

-- Binary bytes live in a restricted filesystem/object archive. PostgreSQL
-- stores only the verified binding needed for cutover/audit.
CREATE TABLE IF NOT EXISTS rent_ops_source_binaries (
  id varchar(160) PRIMARY KEY,
  system text NOT NULL,
  source_collection text NOT NULL CHECK (length(trim(source_collection)) > 0),
  source_id text NOT NULL CHECK (length(trim(source_id)) > 0),
  import_run_id varchar(160) NOT NULL REFERENCES rent_ops_import_runs(id),
  storage_key text NOT NULL CHECK (length(trim(storage_key)) > 0),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  content_type text,
  verification_status text NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'missing', 'mismatch')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(system, source_collection, source_id, checksum_sha256)
);

CREATE INDEX IF NOT EXISTS rent_ops_source_payloads_import_run_index ON rent_ops_source_payloads(import_run_id);
CREATE INDEX IF NOT EXISTS rent_ops_source_binaries_import_run_index ON rent_ops_source_binaries(import_run_id);

-- PUBLIC may otherwise inherit privileges from database defaults. The owning
-- migration/application role retains explicit operator access; no web route
-- receives a handle to either table.
REVOKE ALL ON TABLE rent_ops_source_payloads FROM PUBLIC;
REVOKE ALL ON TABLE rent_ops_source_binaries FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_properties_source_unique ON rent_ops_properties(source_system, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_units_source_unique ON rent_ops_units(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_units_property_index ON rent_ops_units(property_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_people_source_unique ON rent_ops_people(source_system, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_tenancies_source_unique ON rent_ops_tenancies(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_tenancies_unit_index ON rent_ops_tenancies(unit_id);
-- A unit may have at most one current/notice tenancy and one future tenancy.
-- The service checks the same rule before writing; these indexes close the
-- race between two concurrent application conversions.
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_tenancies_current_notice_unit_unique ON rent_ops_tenancies(unit_id) WHERE status IN ('current', 'notice');
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_tenancies_future_unit_unique ON rent_ops_tenancies(unit_id) WHERE status = 'future';
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_lease_terms_source_unique ON rent_ops_lease_terms(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_lease_terms_tenancy_index ON rent_ops_lease_terms(tenancy_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_schedules_source_unique ON rent_ops_recurring_charge_schedules(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_schedules_tenancy_date_index ON rent_ops_recurring_charge_schedules(tenancy_id, effective_from, effective_to);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_ledger_source_unique ON rent_ops_ledger_transactions(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_ledger_tenancy_date_index ON rent_ops_ledger_transactions(tenancy_id, posted_on);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_ledger_posted_reversal_unique ON rent_ops_ledger_transactions(reversal_of_id) WHERE kind = 'reversal' AND status = 'posted';
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_allocations_source_unique ON rent_ops_payment_allocations(source_system, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_allocations_payment_charge_unique ON rent_ops_payment_allocations(payment_transaction_id, charge_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_deposits_source_unique ON rent_ops_security_deposits(source_system, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_subsidy_source_unique ON rent_ops_subsidy_contracts(source_system, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_applications_source_unique ON rent_ops_applications(source_system, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_documents_source_unique ON rent_ops_documents(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_activity_entity_date_index ON rent_ops_activity_events(person_id, occurred_at);

INSERT INTO rent_ops_schema_meta(version, checksum_sha256)
VALUES (1, '__RENT_OPS_V1_CHECKSUM__')
ON CONFLICT (version) DO UPDATE
SET checksum_sha256 = EXCLUDED.checksum_sha256,
    applied_at = now()
WHERE rent_ops_schema_meta.checksum_sha256 = EXCLUDED.checksum_sha256;
