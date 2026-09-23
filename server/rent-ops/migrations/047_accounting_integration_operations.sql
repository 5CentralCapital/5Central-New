-- QBO transport and rental accounting bridge: CloudEvents webhook ledger,
-- deletion tombstones, one rental posting method per entity/period, PM
-- gross-to-net settlements, and write attempts widened for void/delete with
-- explicit prepare/validate stages.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 46 AND checksum_sha256 = '__RENT_OPS_V46_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_integration_operations_predecessor_guard;

CREATE TABLE accounting_qbo_webhook_events (
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  event_source varchar(255) NOT NULL CHECK (length(btrim(event_source)) > 0),
  event_id varchar(255) NOT NULL CHECK (length(btrim(event_id)) > 0),
  event_type varchar(255) NOT NULL,
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  operation varchar(40) NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  delivery_sha256 varchar(64) NOT NULL CHECK (delivery_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('received','routed','processed','unrouted','failed')),
  routed_bindings integer NOT NULL DEFAULT 0 CHECK (routed_bindings >= 0),
  processed_at timestamptz,
  PRIMARY KEY (environment, event_source, event_id)
);
CREATE INDEX accounting_qbo_webhook_events_pending
  ON accounting_qbo_webhook_events (received_at) WHERE state IN ('received','failed');

CREATE TABLE accounting_qbo_deletion_tombstones (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  last_known_version varchar(120),
  source_deleted_at timestamptz,
  detected_via text NOT NULL CHECK (detected_via IN ('webhook','cdc','full_replay')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

CREATE TABLE accounting_rental_posting_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('native_receivables','summary_bridge','not_posted')),
  effective_from date NOT NULL,
  effective_until date,
  cutoff_date date NOT NULL,
  opening_balance_bridge_reference text CHECK (opening_balance_bridge_reference IS NULL OR length(btrim(opening_balance_bridge_reference)) BETWEEN 1 AND 240),
  invoice_delivery_verified boolean NOT NULL DEFAULT false,
  approved_by varchar(160) NOT NULL CHECK (length(btrim(approved_by)) > 0),
  approved_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (cutoff_date >= effective_from),
  CHECK (method <> 'native_receivables' OR invoice_delivery_verified)
);
CREATE INDEX accounting_rental_posting_policies_lookup
  ON accounting_rental_posting_policies (organization_id, legal_entity_id, effective_from);

CREATE FUNCTION accounting_guard_rental_posting_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_rental_posting_policy_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  UPDATE company_legal_entities SET record_revision = record_revision
    WHERE organization_id = NEW.organization_id AND id = NEW.legal_entity_id;
  IF EXISTS (
    SELECT 1 FROM accounting_rental_posting_policies existing
    WHERE existing.organization_id = NEW.organization_id
      AND existing.legal_entity_id = NEW.legal_entity_id
      AND existing.id <> NEW.id
      AND existing.effective_from < coalesce(NEW.effective_until, 'infinity'::date)
      AND NEW.effective_from < coalesce(existing.effective_until, 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'accounting_rental_posting_policy_overlap' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_rental_posting_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_rental_posting_policies
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_rental_posting_policy();

CREATE TABLE accounting_pm_settlements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  manager_name text NOT NULL CHECK (length(btrim(manager_name)) BETWEEN 1 AND 200),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  opening_held_cents bigint NOT NULL,
  gross_collections_cents bigint NOT NULL CHECK (gross_collections_cents >= 0),
  pm_fees_cents bigint NOT NULL CHECK (pm_fees_cents >= 0),
  pm_expenses_cents bigint NOT NULL CHECK (pm_expenses_cents >= 0),
  other_deductions_cents bigint NOT NULL DEFAULT 0 CHECK (other_deductions_cents >= 0),
  owner_remittance_cents bigint NOT NULL CHECK (owner_remittance_cents >= 0),
  closing_held_cents bigint NOT NULL,
  statement_document_id varchar(160),
  intake_packet_id uuid,
  bank_observation_reference text,
  bank_settled_on date,
  qbo_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qbo_references) = 'array'),
  state text NOT NULL CHECK (state IN ('draft','reconciled','exception')),
  exception_reason text,
  source_fingerprint varchar(64) NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id, manager_name, period_start, period_end),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (period_end >= period_start),
  CHECK (opening_held_cents + gross_collections_cents - pm_fees_cents - pm_expenses_cents
    - other_deductions_cents - owner_remittance_cents = closing_held_cents),
  CHECK ((state = 'exception') = (exception_reason IS NOT NULL)),
  CHECK (state <> 'reconciled' OR bank_settled_on IS NOT NULL OR owner_remittance_cents = 0)
);

CREATE TABLE accounting_pm_settlement_lines (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  settlement_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  kind text NOT NULL CHECK (kind IN ('rent_receipt','subsidy_receipt','deposit_receipt','other_receipt','pm_fee','pm_expense','other_deduction','owner_remittance')),
  tenancy_id varchar(160),
  unit_id varchar(160),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  occurred_on date,
  source_page integer CHECK (source_page IS NULL OR source_page > 0),
  PRIMARY KEY (organization_id, settlement_id, line_number),
  FOREIGN KEY (organization_id, settlement_id) REFERENCES accounting_pm_settlements(organization_id, id)
);

ALTER TABLE accounting_qbo_write_attempts DROP CONSTRAINT accounting_qbo_write_attempts_operation_check;
ALTER TABLE accounting_qbo_write_attempts ADD CONSTRAINT accounting_qbo_write_attempts_operation_check
  CHECK (operation IN ('create','update','void','delete'));
ALTER TABLE accounting_qbo_write_attempts DROP CONSTRAINT accounting_qbo_write_attempts_state_check;
ALTER TABLE accounting_qbo_write_attempts ADD CONSTRAINT accounting_qbo_write_attempts_state_check
  CHECK (state IN ('prepared','validated','started','ambiguous','confirmed','failed'));

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (47, '__RENT_OPS_V47_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 47 AND checksum_sha256 = '__RENT_OPS_V47_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_integration_operations_checksum_guard;
