-- Verified QuickBooks company identity handoff and explicit binding confirmation.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 38 AND checksum_sha256 = '__RENT_OPS_V38_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_binding_predecessor_guard;

CREATE TABLE accounting_qbo_pending_bindings (
  pending_id uuid PRIMARY KEY,
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  session_binding_hash varchar(128) CHECK (session_binding_hash IS NULL OR session_binding_hash ~ '^[a-f0-9]{64}$'),
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  provider_company_id varchar(255) NOT NULL CHECK (length(btrim(provider_company_id)) > 0),
  provider_company_name varchar(255),
  provider_legal_name varchar(255),
  home_currency varchar(3) CHECK (home_currency IS NULL OR home_currency ~ '^[A-Z]{3}$'),
  evidence_version varchar(255) NOT NULL CHECK (length(btrim(evidence_version)) > 0),
  company_info_hash varchar(64) NOT NULL CHECK (company_info_hash ~ '^[a-f0-9]{64}$'),
  encrypted_access_token text NOT NULL,
  access_token_iv text NOT NULL,
  access_token_auth_tag text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  refresh_token_iv text NOT NULL,
  refresh_token_auth_tag text NOT NULL,
  encrypted_id_token text,
  id_token_iv text,
  id_token_auth_tag text,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_expires_at timestamptz,
  intuit_tid varchar(255),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  confirmed_by varchar(160),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  UNIQUE (pending_id, organization_id, legal_entity_id, environment, realm_id),
  CHECK ((consumed_at IS NULL AND confirmed_at IS NULL AND confirmed_by IS NULL)
    OR (consumed_at IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  CHECK ((encrypted_id_token IS NULL AND id_token_iv IS NULL AND id_token_auth_tag IS NULL)
    OR (encrypted_id_token IS NOT NULL AND id_token_iv IS NOT NULL AND id_token_auth_tag IS NOT NULL))
);

CREATE INDEX accounting_qbo_pending_bindings_expiry
  ON accounting_qbo_pending_bindings (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE accounting_qbo_binding_confirmations (
  confirmation_id uuid PRIMARY KEY,
  pending_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  provider_company_id varchar(255) NOT NULL,
  company_info_hash varchar(64) NOT NULL CHECK (company_info_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by varchar(160) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  UNIQUE (pending_id),
  FOREIGN KEY (pending_id, organization_id, legal_entity_id, environment, realm_id)
    REFERENCES accounting_qbo_pending_bindings(pending_id, organization_id, legal_entity_id, environment, realm_id)
);

-- A legal entity has at most one realm per provider environment. The row is
-- immutable evidence; reconnects read it and must match CompanyInfo exactly.
CREATE TABLE accounting_qbo_realm_bindings (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  provider_company_id varchar(255) NOT NULL,
  provider_company_name varchar(255),
  provider_legal_name varchar(255),
  home_currency varchar(3) CHECK (home_currency IS NULL OR home_currency ~ '^[A-Z]{3}$'),
  evidence_version varchar(255) NOT NULL CHECK (length(btrim(evidence_version)) > 0),
  company_info_hash varchar(64) NOT NULL CHECK (company_info_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by varchar(160) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment),
  UNIQUE (organization_id, environment, realm_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

COMMENT ON TABLE accounting_qbo_realm_bindings IS
  'Durable, environment-scoped CompanyInfo identity fence. Rows are created only by explicit administrator confirmation and are never silently reassigned.';

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (39, '__RENT_OPS_V39_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 39 AND checksum_sha256 = '__RENT_OPS_V39_CHECKSUM__'
) THEN 1 ELSE 0 END AS accounting_binding_checksum_guard;
