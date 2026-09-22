-- Rent Operations v10: explicitly granted tenant accounts and shared auth
-- throttles. Accounts are distinct from host administrator/investor users.
-- Runtime: SELECT, INSERT, UPDATE accounts; SELECT, INSERT, UPDATE, DELETE
-- auth_limits. No runtime deletion or identity reassignment of accounts.

CREATE TABLE IF NOT EXISTS rent_ops_tenant_accounts (
  id varchar(160) PRIMARY KEY,
  email varchar(240) NOT NULL UNIQUE,
  person_id varchar(160) NOT NULL REFERENCES rent_ops_people(id),
  tenancy_id varchar(160) NOT NULL UNIQUE REFERENCES rent_ops_tenancies(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  password_hash text,
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  activation_token_hash varchar(64) UNIQUE,
  invitation_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT rent_ops_tenant_accounts_email_normalized CHECK (email = lower(btrim(email)) AND length(email) > 3),
  CONSTRAINT rent_ops_tenant_accounts_password_format CHECK (password_hash IS NULL OR password_hash ~ '^scrypt\.v1\.[a-f0-9]{64}\.[a-f0-9]{128}$'),
  CONSTRAINT rent_ops_tenant_accounts_active_password CHECK (status <> 'active' OR password_hash IS NOT NULL),
  CONSTRAINT rent_ops_tenant_accounts_token_pair CHECK ((activation_token_hash IS NULL) = (invitation_expires_at IS NULL)),
  CONSTRAINT rent_ops_tenant_accounts_token_format CHECK (activation_token_hash IS NULL OR activation_token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rent_ops_tenant_accounts_revoked_credentials CHECK (status <> 'revoked' OR (password_hash IS NULL AND activation_token_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS rent_ops_tenant_accounts_person_index ON rent_ops_tenant_accounts(person_id);

CREATE TABLE IF NOT EXISTS rent_ops_tenant_auth_limits (
  key_hash varchar(64) PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0 AND attempts <= 1000000)
);
CREATE INDEX IF NOT EXISTS rent_ops_tenant_auth_limits_expiry_index ON rent_ops_tenant_auth_limits(window_started_at);

CREATE OR REPLACE FUNCTION rent_ops_guard_tenant_account_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.tenancy_id IS DISTINCT FROM OLD.tenancy_id OR NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'rent_ops_tenant_account_identity_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS rent_ops_tenant_account_identity_guard ON rent_ops_tenant_accounts;
CREATE TRIGGER rent_ops_tenant_account_identity_guard
  BEFORE UPDATE ON rent_ops_tenant_accounts FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_tenant_account_identity();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (10, '__RENT_OPS_V10_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 5 AND checksum_sha256 = '__RENT_OPS_V5_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 6 AND checksum_sha256 = '__RENT_OPS_V6_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 7 AND checksum_sha256 = '__RENT_OPS_V7_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 8 AND checksum_sha256 = '__RENT_OPS_V8_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 9 AND checksum_sha256 = '__RENT_OPS_V9_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 10 AND checksum_sha256 = '__RENT_OPS_V10_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v10_post_insert_checksum_guard;
