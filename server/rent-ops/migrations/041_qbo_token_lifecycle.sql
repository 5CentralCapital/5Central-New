-- Preserve Intuit's supported refresh-token hard expiry and make revoked grants
-- explicit so expired credentials cannot enter a repeated refresh loop.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 40 AND checksum_sha256 = '__RENT_OPS_V40_CHECKSUM__'
) THEN 1 ELSE 0 END AS qbo_token_lifecycle_predecessor_guard;

ALTER TABLE accounting_qbo_connections
  ADD COLUMN refresh_token_hard_expires_at timestamptz,
  ADD COLUMN status text;

UPDATE accounting_qbo_connections
   SET status = CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END;

ALTER TABLE accounting_qbo_connections
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT accounting_qbo_connections_status_check
    CHECK (status IN ('active','revoked','needs_reconnect')),
  ADD CONSTRAINT accounting_qbo_connections_status_revocation_check
    CHECK ((status = 'active' AND revoked_at IS NULL)
      OR (status IN ('revoked','needs_reconnect') AND revoked_at IS NOT NULL));

ALTER TABLE accounting_qbo_pending_bindings
  ADD COLUMN refresh_token_hard_expires_at timestamptz;

-- Event rows contain only scoped lifecycle codes and Intuit trace IDs. They
-- intentionally exclude tokens, raw response bodies and provider descriptions.
CREATE TABLE accounting_qbo_connection_events (
  event_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  event_type text NOT NULL CHECK (event_type = 'needs_reconnect'),
  reason_code text NOT NULL CHECK (reason_code IN ('invalid_grant','refresh_token_expired','refresh_token_hard_expired')),
  provider_trace_id varchar(255),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX accounting_qbo_connection_events_scope
  ON accounting_qbo_connection_events (organization_id, legal_entity_id, environment, realm_id, occurred_at DESC);

CREATE FUNCTION accounting_qbo_connection_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accounting_qbo_connection_events_immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER accounting_qbo_connection_events_immutable
  BEFORE UPDATE OR DELETE ON accounting_qbo_connection_events
  FOR EACH ROW EXECUTE FUNCTION accounting_qbo_connection_events_immutable();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (41, '__RENT_OPS_V41_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 41 AND checksum_sha256 = '__RENT_OPS_V41_CHECKSUM__'
) THEN 1 ELSE 0 END AS qbo_token_lifecycle_checksum_guard;
