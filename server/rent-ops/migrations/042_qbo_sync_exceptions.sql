-- Durable QBO mirror exceptions. A provider object that cannot be mirrored
-- exactly stays recorded here until a later provider revision of the same
-- object normalizes completely, so advancing a sync checkpoint or a later
-- incremental run can never erase an unresolved gap. Rows hold only
-- normalizer-authored reason text and provider identifiers, never provider
-- bodies, amounts or credentials.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 41 AND checksum_sha256 = '__RENT_OPS_V41_CHECKSUM__'
) THEN 1 ELSE 0 END AS qbo_sync_exceptions_predecessor_guard;

CREATE TABLE accounting_qbo_sync_exceptions (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  stream varchar(120) NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_.:-]*$'),
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120),
  exception_kind text NOT NULL CHECK (exception_kind IN ('unsupported','missing_from_full_replay')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) BETWEEN 1 AND 50),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_version varchar(120),
  PRIMARY KEY (organization_id, legal_entity_id, environment, realm_id, stream, object_type, object_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK (last_seen_at >= first_seen_at),
  CHECK ((resolved_at IS NULL AND resolved_version IS NULL) OR resolved_at IS NOT NULL)
);
CREATE INDEX accounting_qbo_sync_exceptions_open
  ON accounting_qbo_sync_exceptions (organization_id, legal_entity_id, environment, realm_id, stream)
  WHERE resolved_at IS NULL;

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (42, '__RENT_OPS_V42_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 42 AND checksum_sha256 = '__RENT_OPS_V42_CHECKSUM__'
) THEN 1 ELSE 0 END AS qbo_sync_exceptions_checksum_guard;
