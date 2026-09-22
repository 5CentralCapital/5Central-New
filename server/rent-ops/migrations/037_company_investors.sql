-- Investor accounts, contracts, debt and monthly payment records.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 36 AND checksum_sha256 = '__RENT_OPS_V36_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_investors_predecessor_guard;

CREATE TABLE company_investor_accounts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  contact_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes text,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, contact_id) REFERENCES company_contacts(organization_id, id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_investor_accounts_search ON company_investor_accounts (organization_id, lower(display_name), id) WHERE archived_at IS NULL;

-- Provider party mappings authorize who a provider object represents. They are
-- identity relations only; a payment still needs a fresh provider source
-- resolution before it can count as posted or settled.
CREATE TABLE company_investor_party_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  contact_id uuid,
  party_kind text NOT NULL CHECK (party_kind IN ('investor','third_party_lender')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 240),
  provider text NOT NULL CHECK (provider = 'qbo'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','production')),
  provider_realm_id varchar(32) NOT NULL CHECK (provider_realm_id ~ '^[0-9]{1,32}$'),
  provider_object_type varchar(120) NOT NULL CHECK (provider_object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  provider_object_id varchar(200) NOT NULL CHECK (length(btrim(provider_object_id)) > 0),
  source_document_id varchar(160),
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, account_id) REFERENCES company_investor_accounts(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES company_contacts(organization_id, id),
  FOREIGN KEY (source_document_id) REFERENCES rent_ops_documents(id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (party_kind <> 'third_party_lender' OR source_document_id IS NOT NULL),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, provider, provider_environment, provider_realm_id, provider_object_type, provider_object_id, effective_from)
);
CREATE INDEX company_investor_party_mappings_account_date ON company_investor_party_mappings (organization_id, account_id, legal_entity_id, effective_from, effective_to) WHERE archived_at IS NULL;

CREATE TABLE company_investor_instruments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  account_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  kind text NOT NULL CHECK (kind IN ('equity','preferred_equity','private_loan','member_loan')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paid_off','closed','archived')),
  legal_entity_id uuid NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  committed_cents bigint NOT NULL DEFAULT 0 CHECK (committed_cents >= 0),
  face_principal_cents bigint NOT NULL DEFAULT 0 CHECK (face_principal_cents >= 0),
  effective_from date NOT NULL,
  maturity_on date,
  ownership_bps integer CHECK (ownership_bps IS NULL OR (ownership_bps >= 0 AND ownership_bps <= 10000)),
  notes text,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, account_id) REFERENCES company_investor_accounts(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (maturity_on IS NULL OR maturity_on >= effective_from),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, currency)
);

CREATE TABLE company_investor_instrument_properties (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  instrument_id uuid NOT NULL,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  PRIMARY KEY (organization_id, instrument_id, property_id),
  FOREIGN KEY (organization_id, instrument_id) REFERENCES company_investor_instruments(organization_id, id)
);
CREATE TABLE company_investor_instrument_projects (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  instrument_id uuid NOT NULL,
  project_id varchar(160) NOT NULL,
  PRIMARY KEY (organization_id, instrument_id, project_id),
  FOREIGN KEY (organization_id, instrument_id) REFERENCES company_investor_instruments(organization_id, id)
);

CREATE TABLE company_investor_contracts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  instrument_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  kind text NOT NULL CHECK (kind IN ('investment_agreement','promissory_note','operating_agreement','amendment','distribution_policy','other')),
  status text NOT NULL CHECK (status IN ('draft','in_review','active','superseded','expired','void')),
  current_version_id uuid,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, instrument_id) REFERENCES company_investor_instruments(organization_id, id),
  UNIQUE (organization_id, id)
);

CREATE TABLE company_investor_contract_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  contract_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL CHECK (status IN ('draft','in_review','active','superseded','expired','void')),
  effective_from date NOT NULL,
  effective_to date,
  signed_on date,
  schedule text NOT NULL CHECK (schedule IN ('monthly','quarterly','annual','at_maturity','custom')),
  payment_day integer CHECK (payment_day IS NULL OR (payment_day >= 1 AND payment_day <= 31)),
  month_end_rule text NOT NULL CHECK (month_end_rule IN ('calendar_day_or_month_end','month_end')),
  annual_rate numeric(18,12),
  preferred_return_rate numeric(18,12),
  return_multiple numeric(18,12),
  fixed_payment_cents bigint CHECK (fixed_payment_cents IS NULL OR fixed_payment_cents >= 0),
  principal_payment_cents bigint CHECK (principal_payment_cents IS NULL OR principal_payment_cents >= 0),
  interest_payment_cents bigint CHECK (interest_payment_cents IS NULL OR interest_payment_cents >= 0),
  return_of_capital_cents bigint CHECK (return_of_capital_cents IS NULL OR return_of_capital_cents >= 0),
  distribution_cents bigint CHECK (distribution_cents IS NULL OR distribution_cents >= 0),
  balloon_cents bigint CHECK (balloon_cents IS NULL OR balloon_cents >= 0),
  original_principal_cents bigint CHECK (original_principal_cents IS NULL OR original_principal_cents >= 0),
  maturity_total_cents bigint CHECK (maturity_total_cents IS NULL OR maturity_total_cents >= 0),
  fixed_profit_cents bigint CHECK (fixed_profit_cents IS NULL OR fixed_profit_cents >= 0),
  maturity_payoff_cents bigint CHECK (maturity_payoff_cents IS NULL OR maturity_payoff_cents >= 0),
  third_party_installment_cents bigint CHECK (third_party_installment_cents IS NULL OR third_party_installment_cents >= 0),
  investor_spread_cents bigint CHECK (investor_spread_cents IS NULL OR investor_spread_cents >= 0),
  unknown_component_kinds text[] NOT NULL DEFAULT '{}',
  interest_only boolean NOT NULL DEFAULT false,
  day_count text NOT NULL CHECK (day_count IN ('actual_365','actual_360','30_360')),
  created_by varchar(160) NOT NULL CHECK (length(btrim(created_by)) > 0),
  approved_by varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, contract_id) REFERENCES company_investor_contracts(organization_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (schedule <> 'monthly' OR payment_day IS NOT NULL),
  CHECK (status <> 'active' OR approved_by IS NOT NULL),
  UNIQUE (organization_id, contract_id, version_no),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, contract_id, id)
);
CREATE UNIQUE INDEX company_investor_active_contract_version ON company_investor_contract_versions (organization_id, contract_id) WHERE status = 'active';

ALTER TABLE company_investor_contracts ADD CONSTRAINT company_investor_contract_current_version_fkey
  FOREIGN KEY (organization_id, id, current_version_id) REFERENCES company_investor_contract_versions(organization_id, contract_id, id);

CREATE TABLE company_investor_contract_documents (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  contract_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  document_id varchar(160) NOT NULL REFERENCES rent_ops_documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, contract_version_id, document_id),
  FOREIGN KEY (organization_id, contract_id) REFERENCES company_investor_contracts(organization_id, id),
  FOREIGN KEY (organization_id, contract_id, contract_version_id) REFERENCES company_investor_contract_versions(organization_id, contract_id, id)
);

CREATE TABLE company_investor_remittance_instructions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  account_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  contract_id uuid,
  legal_entity_id uuid NOT NULL,
  party_mapping_id uuid NOT NULL,
  beneficiary_kind text NOT NULL CHECK (beneficiary_kind = 'third_party_lender'),
  source_document_id varchar(160) NOT NULL REFERENCES rent_ops_documents(id),
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes text,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, account_id) REFERENCES company_investor_accounts(organization_id, id),
  FOREIGN KEY (organization_id, instrument_id) REFERENCES company_investor_instruments(organization_id, id),
  FOREIGN KEY (organization_id, contract_id) REFERENCES company_investor_contracts(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, party_mapping_id) REFERENCES company_investor_party_mappings(organization_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_investor_remittance_date ON company_investor_remittance_instructions (organization_id, account_id, instrument_id, effective_from, effective_to) WHERE archived_at IS NULL;

CREATE TABLE company_investor_debt (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  account_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  debt_kind text NOT NULL CHECK (debt_kind IN ('private_loan','member_loan')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  original_principal_cents bigint NOT NULL CHECK (original_principal_cents >= 0),
  -- NULL is intentional: an agreement can state a principal without proving
  -- how much capital was actually funded. Forecasts must remain unresolved
  -- until that opening amount is documented.
  funded_capital_cents bigint CHECK (funded_capital_cents IS NULL OR funded_capital_cents >= 0),
  -- NULL is intentional when the current balance has not been supported by a
  -- statement or other authoritative source yet.
  outstanding_principal_cents bigint CHECK (outstanding_principal_cents IS NULL OR outstanding_principal_cents >= 0),
  annual_rate numeric(18,12) NOT NULL,
  schedule text NOT NULL CHECK (schedule IN ('monthly','quarterly','annual','at_maturity','custom')),
  payment_day integer CHECK (payment_day IS NULL OR (payment_day >= 1 AND payment_day <= 31)),
  month_end_rule text NOT NULL CHECK (month_end_rule IN ('calendar_day_or_month_end','month_end')),
  first_due_month date,
  interest_only_until date,
  maturity_on date,
  amortization_months integer CHECK (amortization_months IS NULL OR amortization_months > 0),
  balloon_cents bigint CHECK (balloon_cents IS NULL OR balloon_cents >= 0),
  day_count text NOT NULL CHECK (day_count IN ('actual_365','actual_360','30_360')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, account_id) REFERENCES company_investor_accounts(organization_id, id),
  FOREIGN KEY (organization_id, instrument_id, currency) REFERENCES company_investor_instruments(organization_id, id, currency),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (funded_capital_cents IS NULL OR funded_capital_cents <= original_principal_cents),
  CHECK (outstanding_principal_cents IS NULL OR outstanding_principal_cents <= original_principal_cents),
  CHECK (schedule <> 'monthly' OR payment_day IS NOT NULL),
  CHECK (first_due_month IS NULL OR date_part('day', first_due_month) = 1),
  CHECK (interest_only_until IS NULL OR date_part('day', interest_only_until) = 1),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, instrument_id)
);

CREATE TABLE company_investor_obligations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  account_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  period_month date NOT NULL,
  due_on date NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  principal_cents bigint NOT NULL CHECK (principal_cents >= 0),
  interest_cents bigint NOT NULL CHECK (interest_cents >= 0),
  return_of_capital_cents bigint NOT NULL CHECK (return_of_capital_cents >= 0),
  distribution_cents bigint NOT NULL CHECK (distribution_cents >= 0),
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  balloon_cents bigint NOT NULL CHECK (balloon_cents >= 0),
  unknown_expected_cents bigint NOT NULL DEFAULT 0 CHECK (unknown_expected_cents >= 0),
  unknown_component_kinds text[] NOT NULL DEFAULT '{}',
  total_expected_cents bigint CHECK (total_expected_cents IS NULL OR total_expected_cents >= 0),
  known_minimum_cents bigint NOT NULL DEFAULT 0 CHECK (known_minimum_cents >= 0),
  amount_complete boolean NOT NULL DEFAULT true,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, account_id) REFERENCES company_investor_accounts(organization_id, id),
  FOREIGN KEY (organization_id, instrument_id, currency) REFERENCES company_investor_instruments(organization_id, id, currency),
  FOREIGN KEY (organization_id, contract_id, contract_version_id) REFERENCES company_investor_contract_versions(organization_id, contract_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (date_part('day', period_month) = 1),
  CHECK (known_minimum_cents = principal_cents + interest_cents + return_of_capital_cents + distribution_cents + fee_cents + balloon_cents + unknown_expected_cents),
  CHECK (NOT amount_complete OR total_expected_cents IS NOT NULL),
  CHECK (amount_complete OR total_expected_cents IS NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, instrument_id, contract_id, contract_version_id, period_month)
);
CREATE INDEX company_investor_obligations_month ON company_investor_obligations (organization_id, account_id, period_month, due_on, id);

CREATE TABLE company_investor_payments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  account_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  contract_id uuid,
  obligation_id uuid,
  remittance_instruction_id uuid,
  legal_entity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('contribution','return_of_capital','distribution','principal','interest','fee','balloon','correction')),
  status text NOT NULL CHECK (status IN ('manual_recorded','qbo_posted','bank_settled','reversed')),
  method text NOT NULL CHECK (method IN ('manual','ach','wire','check','qbo')),
  payment_on date NOT NULL,
  period_month date,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  principal_cents bigint NOT NULL,
  interest_cents bigint NOT NULL,
  return_of_capital_cents bigint NOT NULL,
  distribution_cents bigint NOT NULL,
  fee_cents bigint NOT NULL,
  balloon_cents bigint NOT NULL,
  unclassified_cents bigint NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL,
  unapplied_cents bigint NOT NULL DEFAULT 0 CHECK (unapplied_cents >= 0),
  reverses_payment_id uuid,
  correction_reason text,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_by varchar(160) NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, account_id) REFERENCES company_investor_accounts(organization_id, id),
  FOREIGN KEY (organization_id, instrument_id, currency) REFERENCES company_investor_instruments(organization_id, id, currency),
  FOREIGN KEY (organization_id, contract_id) REFERENCES company_investor_contracts(organization_id, id),
  FOREIGN KEY (organization_id, obligation_id) REFERENCES company_investor_obligations(organization_id, id),
  FOREIGN KEY (organization_id, remittance_instruction_id) REFERENCES company_investor_remittance_instructions(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, reverses_payment_id) REFERENCES company_investor_payments(organization_id, id),
  CHECK (period_month IS NULL OR date_part('day', period_month) = 1),
  CHECK (amount_cents = principal_cents + interest_cents + return_of_capital_cents + distribution_cents + fee_cents + balloon_cents + unclassified_cents),
  CHECK (status <> 'reversed' OR reverses_payment_id IS NOT NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, reverses_payment_id)
);
CREATE INDEX company_investor_payments_account_date ON company_investor_payments (organization_id, account_id, payment_on DESC, id DESC);

CREATE TABLE company_investor_payment_allocations (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  payment_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  principal_cents bigint NOT NULL DEFAULT 0,
  interest_cents bigint NOT NULL DEFAULT 0,
  return_of_capital_cents bigint NOT NULL DEFAULT 0,
  distribution_cents bigint NOT NULL DEFAULT 0,
  fee_cents bigint NOT NULL DEFAULT 0,
  balloon_cents bigint NOT NULL DEFAULT 0,
  unclassified_cents bigint NOT NULL DEFAULT 0,
  allocated_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, payment_id, obligation_id),
  FOREIGN KEY (organization_id, payment_id) REFERENCES company_investor_payments(organization_id, id),
  FOREIGN KEY (organization_id, obligation_id) REFERENCES company_investor_obligations(organization_id, id),
  CHECK (allocated_cents = principal_cents + interest_cents + return_of_capital_cents + distribution_cents + fee_cents + balloon_cents + unclassified_cents)
);
CREATE INDEX company_investor_payment_allocations_obligation ON company_investor_payment_allocations (organization_id, obligation_id);

CREATE TABLE company_investor_payment_sources (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  payment_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('qbo','bank','plaid')),
  source_scope varchar(200) NOT NULL,
  external_transaction_id varchar(200) NOT NULL,
  external_line_id varchar(200) NOT NULL,
  source_revision varchar(120) NOT NULL,
  source_environment text,
  source_realm_id varchar(32),
  source_object_type varchar(120),
  source_object_id varchar(200),
  source_line_id varchar(200),
  source_version varchar(120),
  source_reference jsonb NOT NULL CHECK (jsonb_typeof(source_reference) = 'object'),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_cents bigint NOT NULL,
  coverage text NOT NULL CHECK (coverage = 'verified'),
  verified_at timestamptz NOT NULL,
  watermark jsonb NOT NULL CHECK (jsonb_typeof(watermark) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, payment_id, provider),
  FOREIGN KEY (organization_id, payment_id) REFERENCES company_investor_payments(organization_id, id),
  UNIQUE (organization_id, provider, source_scope, external_transaction_id, external_line_id, source_revision)
);

CREATE FUNCTION company_guard_investor_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'company_investor_history_delete_forbidden' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME IN ('company_investor_accounts','company_investor_instruments','company_investor_contracts','company_investor_contract_versions','company_investor_debt','company_investor_obligations','company_investor_payments','company_investor_party_mappings','company_investor_remittance_instructions') THEN
    IF to_jsonb(NEW)->'id' IS DISTINCT FROM to_jsonb(OLD)->'id' OR to_jsonb(NEW)->'organization_id' IS DISTINCT FROM to_jsonb(OLD)->'organization_id' THEN
      RAISE EXCEPTION 'company_investor_identity_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'company_investor_instruments' AND (to_jsonb(NEW)->'account_id' IS DISTINCT FROM to_jsonb(OLD)->'account_id' OR to_jsonb(NEW)->'legal_entity_id' IS DISTINCT FROM to_jsonb(OLD)->'legal_entity_id' OR to_jsonb(NEW)->'currency' IS DISTINCT FROM to_jsonb(OLD)->'currency' OR to_jsonb(NEW)->'kind' IS DISTINCT FROM to_jsonb(OLD)->'kind') THEN
    RAISE EXCEPTION 'company_investor_instrument_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_investor_contract_versions' AND (to_jsonb(NEW)->'contract_id' IS DISTINCT FROM to_jsonb(OLD)->'contract_id' OR to_jsonb(NEW)->'version_no' IS DISTINCT FROM to_jsonb(OLD)->'version_no') THEN
    RAISE EXCEPTION 'company_investor_contract_version_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_investor_obligations' AND (to_jsonb(NEW)->'account_id' IS DISTINCT FROM to_jsonb(OLD)->'account_id' OR to_jsonb(NEW)->'instrument_id' IS DISTINCT FROM to_jsonb(OLD)->'instrument_id' OR to_jsonb(NEW)->'contract_id' IS DISTINCT FROM to_jsonb(OLD)->'contract_id' OR to_jsonb(NEW)->'contract_version_id' IS DISTINCT FROM to_jsonb(OLD)->'contract_version_id' OR to_jsonb(NEW)->'period_month' IS DISTINCT FROM to_jsonb(OLD)->'period_month' OR to_jsonb(NEW)->'currency' IS DISTINCT FROM to_jsonb(OLD)->'currency') THEN
    RAISE EXCEPTION 'company_investor_obligation_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_investor_payments' AND (to_jsonb(NEW)->'account_id' IS DISTINCT FROM to_jsonb(OLD)->'account_id' OR to_jsonb(NEW)->'instrument_id' IS DISTINCT FROM to_jsonb(OLD)->'instrument_id' OR to_jsonb(NEW)->'currency' IS DISTINCT FROM to_jsonb(OLD)->'currency' OR to_jsonb(NEW)->'amount_cents' IS DISTINCT FROM to_jsonb(OLD)->'amount_cents' OR to_jsonb(NEW)->'reverses_payment_id' IS DISTINCT FROM to_jsonb(OLD)->'reverses_payment_id') THEN
    RAISE EXCEPTION 'company_investor_payment_history_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_investor_party_mappings' AND (to_jsonb(NEW)->'account_id' IS DISTINCT FROM to_jsonb(OLD)->'account_id' OR to_jsonb(NEW)->'legal_entity_id' IS DISTINCT FROM to_jsonb(OLD)->'legal_entity_id' OR to_jsonb(NEW)->'provider' IS DISTINCT FROM to_jsonb(OLD)->'provider' OR to_jsonb(NEW)->'provider_environment' IS DISTINCT FROM to_jsonb(OLD)->'provider_environment' OR to_jsonb(NEW)->'provider_realm_id' IS DISTINCT FROM to_jsonb(OLD)->'provider_realm_id' OR to_jsonb(NEW)->'provider_object_type' IS DISTINCT FROM to_jsonb(OLD)->'provider_object_type' OR to_jsonb(NEW)->'provider_object_id' IS DISTINCT FROM to_jsonb(OLD)->'provider_object_id') THEN
    RAISE EXCEPTION 'company_investor_party_mapping_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_investor_remittance_instructions' AND (to_jsonb(NEW)->'account_id' IS DISTINCT FROM to_jsonb(OLD)->'account_id' OR to_jsonb(NEW)->'instrument_id' IS DISTINCT FROM to_jsonb(OLD)->'instrument_id' OR to_jsonb(NEW)->'legal_entity_id' IS DISTINCT FROM to_jsonb(OLD)->'legal_entity_id' OR to_jsonb(NEW)->'party_mapping_id' IS DISTINCT FROM to_jsonb(OLD)->'party_mapping_id') THEN
    RAISE EXCEPTION 'company_investor_remittance_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_investor_accounts_identity BEFORE UPDATE OR DELETE ON company_investor_accounts FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_instruments_identity BEFORE UPDATE OR DELETE ON company_investor_instruments FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_contracts_identity BEFORE UPDATE OR DELETE ON company_investor_contracts FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_contract_versions_identity BEFORE UPDATE OR DELETE ON company_investor_contract_versions FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_debt_identity BEFORE UPDATE OR DELETE ON company_investor_debt FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_obligations_identity BEFORE UPDATE OR DELETE ON company_investor_obligations FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_payments_identity BEFORE UPDATE OR DELETE ON company_investor_payments FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_party_mappings_identity BEFORE UPDATE OR DELETE ON company_investor_party_mappings FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE TRIGGER company_investor_remittance_identity BEFORE UPDATE OR DELETE ON company_investor_remittance_instructions FOR EACH ROW EXECUTE FUNCTION company_guard_investor_identity();
CREATE FUNCTION company_guard_investor_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'company_investor_source_delete_forbidden' USING ERRCODE = '23514'; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.source_scope IS DISTINCT FROM OLD.source_scope
    OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
    OR NEW.external_line_id IS DISTINCT FROM OLD.external_line_id
    OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.coverage IS DISTINCT FROM OLD.coverage
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    OR NEW.watermark IS DISTINCT FROM OLD.watermark THEN
    RAISE EXCEPTION 'company_investor_source_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_investor_sources_immutable BEFORE UPDATE OR DELETE ON company_investor_payment_sources FOR EACH ROW EXECUTE FUNCTION company_guard_investor_source();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (37, '__RENT_OPS_V37_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 37 AND checksum_sha256 = '__RENT_OPS_V37_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_investors_checksum_guard;
