-- QBO receivables mirror (QBO Financial Source Plan, QS02): the posted
-- customer-linked activity that tenant histories, statements and aging are
-- read from. QuickBooks is the authority; these rows are a verified copy.
--
-- * accounting_qbo_receivable_documents holds the CURRENT provider revision
--   of each Invoice, CreditMemo, Payment, SalesReceipt, RefundReceipt and
--   receivable JournalEntry. A newer revision that cannot be mirrored marks
--   the document 'unsupported' so its effects stop counting.
-- * accounting_qbo_receivable_effects and _applications are append-only per
--   provider revision, so an edited or voided transaction keeps its earlier
--   revision for traceability without being counted twice.
-- * Deletions stay in accounting_qbo_source_objects.deleted_at and the
--   existing tombstones; readers join to the live source object.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 49 AND checksum_sha256 = '__RENT_OPS_V49_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_qbo_receivables_predecessor_guard;

CREATE TABLE accounting_qbo_receivable_documents (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(40) NOT NULL CHECK (object_type IN ('Invoice','CreditMemo','Payment','SalesReceipt','RefundReceipt','JournalEntry')),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120) NOT NULL CHECK (length(btrim(object_version)) > 0),
  source_object_id uuid NOT NULL,
  mirror_state text NOT NULL CHECK (mirror_state IN ('current','unsupported')),
  -- NULL only for a JournalEntry, whose receivable lines each name a customer.
  customer_object_id varchar(200) CHECK (customer_object_id IS NULL OR length(btrim(customer_object_id)) > 0),
  doc_number varchar(40),
  txn_date date NOT NULL,
  due_date date,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_cents bigint NOT NULL,
  -- Invoice.Balance, CreditMemo remaining credit or Payment.UnappliedAmt as
  -- reported by QuickBooks; NULL when the type has none or it was absent.
  open_balance_cents bigint,
  posting_state text NOT NULL CHECK (posting_state IN ('posted','voided')),
  -- Delivery and online-collection controls, kept to prove record-only
  -- imports send nothing and accept no online payment.
  email_status varchar(20) CHECK (email_status IS NULL OR email_status IN ('NotSet','NeedToSend','EmailSent')),
  allow_online_card boolean,
  allow_online_ach boolean,
  allow_ipn boolean,
  bill_email_present boolean NOT NULL DEFAULT false,
  unsupported_reason varchar(500),
  provider_updated_at timestamptz NOT NULL,
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, source_object_id)
    REFERENCES accounting_qbo_source_objects(organization_id, legal_entity_id, environment, realm_id, id),
  CHECK (customer_object_id IS NOT NULL OR object_type = 'JournalEntry'),
  CHECK ((mirror_state = 'unsupported') = (unsupported_reason IS NOT NULL))
);
CREATE INDEX accounting_qbo_receivable_documents_customer
  ON accounting_qbo_receivable_documents (organization_id, legal_entity_id, environment, realm_id, customer_object_id, txn_date);

CREATE TABLE accounting_qbo_receivable_effects (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(40) NOT NULL CHECK (object_type IN ('Invoice','CreditMemo','Payment','SalesReceipt','RefundReceipt','JournalEntry')),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120) NOT NULL CHECK (length(btrim(object_version)) > 0),
  effect_id varchar(220) NOT NULL CHECK (length(btrim(effect_id)) > 0),
  line_number integer NOT NULL CHECK (line_number > 0),
  customer_object_id varchar(200) NOT NULL CHECK (length(btrim(customer_object_id)) > 0),
  effect_kind text NOT NULL CHECK (effect_kind IN ('charge','discount','credit','payment','receipt','refund','adjustment')),
  -- Signed: positive increases what the customer owes, negative reduces it.
  amount_cents bigint NOT NULL,
  account_object_id varchar(200),
  item_object_id varchar(200),
  class_object_id varchar(200),
  department_object_id varchar(200),
  service_date date,
  description varchar(500),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, effect_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX accounting_qbo_receivable_effects_customer
  ON accounting_qbo_receivable_effects (organization_id, legal_entity_id, environment, realm_id, customer_object_id);

CREATE TABLE accounting_qbo_receivable_applications (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(40) NOT NULL CHECK (object_type IN ('Payment')),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120) NOT NULL CHECK (length(btrim(object_version)) > 0),
  application_id varchar(220) NOT NULL CHECK (length(btrim(application_id)) > 0),
  target_type varchar(40) NOT NULL CHECK (target_type IN ('Invoice','CreditMemo','JournalEntry')),
  target_id varchar(200) NOT NULL CHECK (length(btrim(target_id)) > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, application_id, target_type, target_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX accounting_qbo_receivable_applications_target
  ON accounting_qbo_receivable_applications (organization_id, legal_entity_id, environment, realm_id, target_type, target_id);

CREATE FUNCTION accounting_guard_receivable_revision_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accounting_receivable_revision_history_is_immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER accounting_qbo_receivable_effects_history
  BEFORE UPDATE OR DELETE ON accounting_qbo_receivable_effects
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_receivable_revision_history();
CREATE TRIGGER accounting_qbo_receivable_applications_history
  BEFORE UPDATE OR DELETE ON accounting_qbo_receivable_applications
  FOR EACH ROW EXECUTE FUNCTION accounting_guard_receivable_revision_history();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (50, '__RENT_OPS_V50_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 50 AND checksum_sha256 = '__RENT_OPS_V50_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_qbo_receivables_checksum_guard;
