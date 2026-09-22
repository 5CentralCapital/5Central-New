-- Verified provider records and shared financial source allocation.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 33 AND checksum_sha256 = '__RENT_OPS_V33_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_foundation_predecessor_guard;

CREATE TABLE accounting_qbo_connections (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  encrypted_access_token text,
  access_token_iv text,
  access_token_auth_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_auth_tag text,
  encrypted_id_token text,
  id_token_iv text,
  id_token_auth_tag text,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_expires_at timestamptz,
  intuit_tid varchar(255),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id),
  UNIQUE (organization_id, environment, realm_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK ((revoked_at IS NULL AND encrypted_access_token IS NOT NULL AND encrypted_refresh_token IS NOT NULL)
    OR (revoked_at IS NOT NULL AND encrypted_access_token IS NULL AND encrypted_refresh_token IS NULL)),
  CHECK ((encrypted_access_token IS NULL AND access_token_iv IS NULL AND access_token_auth_tag IS NULL)
    OR (encrypted_access_token IS NOT NULL AND access_token_iv IS NOT NULL AND access_token_auth_tag IS NOT NULL)),
  CHECK ((encrypted_refresh_token IS NULL AND refresh_token_iv IS NULL AND refresh_token_auth_tag IS NULL)
    OR (encrypted_refresh_token IS NOT NULL AND refresh_token_iv IS NOT NULL AND refresh_token_auth_tag IS NOT NULL)),
  CHECK ((encrypted_id_token IS NULL AND id_token_iv IS NULL AND id_token_auth_tag IS NULL)
    OR (encrypted_id_token IS NOT NULL AND id_token_iv IS NOT NULL AND id_token_auth_tag IS NOT NULL))
);

CREATE TABLE accounting_qbo_oauth_states (
  state_hash varchar(128) PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  session_binding_hash varchar(128) CHECK (session_binding_hash IS NULL OR session_binding_hash ~ '^[a-f0-9]{64}$'),
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  expected_realm_id varchar(32) CHECK (expected_realm_id IS NULL OR expected_realm_id ~ '^[0-9]{1,32}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX accounting_qbo_oauth_states_expiry ON accounting_qbo_oauth_states (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE accounting_qbo_capabilities (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  capability varchar(120) NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_.-]*$'),
  enabled boolean NOT NULL DEFAULT false,
  evidence text NOT NULL CHECK (evidence IN ('unverified','synthetic','live_provider_readback')),
  evidence_version varchar(120) NOT NULL,
  verified_at timestamptz NOT NULL,
  provider_trace_id varchar(255),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, capability),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (NOT enabled OR evidence = 'live_provider_readback')
);

CREATE TABLE accounting_qbo_refresh_leases (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  owner_id varchar(160) NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  lease_until timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

-- Provider bodies are the only JSON field in the mirror. Identities and all
-- fields used for joins, amounts, dates and statuses remain relational.
CREATE TABLE accounting_qbo_source_objects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120) NOT NULL CHECK (length(btrim(object_version)) > 0),
  provider_updated_at timestamptz,
  body_hash varchar(64) NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  provider_body jsonb NOT NULL CHECK (jsonb_typeof(provider_body) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, realm_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX accounting_qbo_source_objects_scope_updated
  ON accounting_qbo_source_objects (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, received_at DESC);

CREATE TABLE accounting_qbo_transactions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  source_object_id uuid NOT NULL,
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120) NOT NULL CHECK (length(btrim(object_version)) > 0),
  transaction_date date NOT NULL,
  posting_state text NOT NULL CHECK (posting_state IN ('posted','voided','unknown')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  watermark varchar(255) NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, realm_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, source_object_id)
    REFERENCES accounting_qbo_source_objects(organization_id, legal_entity_id, environment, realm_id, id)
);
CREATE INDEX accounting_qbo_transactions_scope_date
  ON accounting_qbo_transactions (organization_id, legal_entity_id, environment, realm_id, transaction_date, id);

-- One row represents one object+line identity across all provider revisions.
-- This is the row allocation consumers lock before reserving any cents.
CREATE TABLE accounting_qbo_source_line_balances (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  line_id varchar(200) NOT NULL CHECK (length(btrim(line_id)) > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  flow text NOT NULL DEFAULT 'unknown' CHECK (flow IN ('incoming','outgoing','unknown')),
  line_role text NOT NULL DEFAULT 'unknown' CHECK (line_role IN ('receipt','expense','payable','payment_source','unknown')),
  transaction_type varchar(120) NOT NULL CHECK (transaction_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  account_object_id varchar(200),
  counterparty_object_id varchar(200),
  latest_version varchar(120) NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  allocation_blocked boolean NOT NULL DEFAULT false,
  posting_state text NOT NULL CHECK (posting_state IN ('posted','voided','unknown')),
  posted_on date NOT NULL,
  settlement_state text NOT NULL CHECK (settlement_state IN ('unknown','unsettled','settled','voided')),
  settled_on date,
  settled_amount_cents bigint CHECK (settled_amount_cents IS NULL OR settled_amount_cents >= 0),
  watermark varchar(255) NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK ((settlement_state = 'settled') = (settled_on IS NOT NULL AND settled_amount_cents IS NOT NULL)),
  CHECK (settlement_state <> 'voided' OR posting_state = 'voided')
);

CREATE TABLE accounting_qbo_transaction_lines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  transaction_id uuid NOT NULL,
  source_object_id uuid NOT NULL,
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  line_number integer NOT NULL CHECK (line_number > 0),
  source_line_id varchar(200) NOT NULL CHECK (length(btrim(source_line_id)) > 0),
  source_version varchar(120) NOT NULL,
  transaction_type varchar(120) NOT NULL CHECK (transaction_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  flow text NOT NULL DEFAULT 'unknown' CHECK (flow IN ('incoming','outgoing','unknown')),
  line_role text NOT NULL DEFAULT 'unknown' CHECK (line_role IN ('receipt','expense','payable','payment_source','unknown')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  posting_state text NOT NULL CHECK (posting_state IN ('posted','voided','unknown')),
  posted_on date NOT NULL,
  settlement_state text NOT NULL CHECK (settlement_state IN ('unknown','unsettled','settled','voided')),
  settled_on date,
  settled_amount_cents bigint CHECK (settled_amount_cents IS NULL OR settled_amount_cents >= 0),
  account_object_id varchar(200),
  counterparty_object_id varchar(200),
  description text,
  watermark varchar(255) NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, source_line_id, source_version),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, transaction_id)
    REFERENCES accounting_qbo_transactions(organization_id, legal_entity_id, environment, realm_id, id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, source_object_id)
    REFERENCES accounting_qbo_source_objects(organization_id, legal_entity_id, environment, realm_id, id),
  CHECK ((settlement_state = 'settled') = (settled_on IS NOT NULL AND settled_amount_cents IS NOT NULL)),
  CHECK (settlement_state <> 'voided' OR posting_state = 'voided')
);
CREATE INDEX accounting_qbo_transaction_lines_scope_line
  ON accounting_qbo_transaction_lines (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, source_line_id, source_version);

-- Links identify the local consumer. Allocations are separate rows so the
-- central balance can be locked and summed across projects and investors.
CREATE TABLE accounting_qbo_source_line_links (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL,
  object_id varchar(200) NOT NULL,
  line_id varchar(200) NOT NULL,
  source_version varchar(120) NOT NULL CHECK (length(btrim(source_version)) > 0),
  consumer_kind varchar(80) NOT NULL CHECK (consumer_kind ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  consumer_id varchar(200) NOT NULL,
  relation_kind varchar(80) NOT NULL CHECK (relation_kind ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, source_version, consumer_kind, consumer_id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id)
    REFERENCES accounting_qbo_source_line_balances(organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, source_version)
    REFERENCES accounting_qbo_transaction_lines(organization_id, legal_entity_id, environment, realm_id, object_type, object_id, source_line_id, source_version)
);

CREATE TABLE accounting_qbo_source_line_allocations (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL,
  object_id varchar(200) NOT NULL,
  line_id varchar(200) NOT NULL,
  source_version varchar(120) NOT NULL CHECK (length(btrim(source_version)) > 0),
  consumer_kind varchar(80) NOT NULL CHECK (consumer_kind ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  consumer_id varchar(200) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, consumer_kind, consumer_id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id)
    REFERENCES accounting_qbo_source_line_balances(organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, source_version)
    REFERENCES accounting_qbo_transaction_lines(organization_id, legal_entity_id, environment, realm_id, object_type, object_id, source_line_id, source_version)
);

CREATE TABLE accounting_qbo_sync_checkpoints (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  stream varchar(120) NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_.:-]*$'),
  watermark varchar(255),
  cursor varchar(255),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, stream),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

CREATE TABLE accounting_qbo_coverage (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  stream varchar(120) NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_.:-]*$'),
  status text NOT NULL CHECK (status IN ('unavailable','partial','complete')),
  evidence text NOT NULL CHECK (evidence IN ('unverified','synthetic','live_provider_readback')),
  basis text NOT NULL CHECK (basis IN ('source_transactions','provider_report','unknown')),
  watermark varchar(255),
  covered_from date,
  covered_through date,
  observed_at timestamptz NOT NULL,
  object_count bigint NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  transaction_count bigint NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  line_count bigint NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  reason text,
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, stream),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE TABLE accounting_qbo_coverage_gaps (
  organization_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL,
  realm_id varchar(32) NOT NULL,
  stream varchar(120) NOT NULL,
  gap_from date NOT NULL,
  gap_through date NOT NULL,
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, stream, gap_from),
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, stream)
    REFERENCES accounting_qbo_coverage(organization_id, legal_entity_id, environment, realm_id, stream),
  CHECK (gap_through >= gap_from)
);

CREATE TABLE accounting_qbo_write_attempts (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  operation_key varchar(255) NOT NULL,
  entity varchar(120) NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','update')),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('started','ambiguous','confirmed','failed')),
  provider_entity_id varchar(200),
  provider_version varchar(120),
  provider_trace_id varchar(255),
  readback_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, operation_key),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

CREATE INDEX accounting_qbo_line_allocations_consumer
  ON accounting_qbo_source_line_allocations (organization_id, consumer_kind, consumer_id);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (34, '__RENT_OPS_V34_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 34 AND checksum_sha256 = '__RENT_OPS_V34_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_foundation_checksum_guard;
