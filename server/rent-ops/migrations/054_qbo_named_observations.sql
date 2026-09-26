-- Preserve repeated named-profile observations without rewriting QBO revisions.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 53 AND checksum_sha256 = '__RENT_OPS_V53_CHECKSUM__'
) THEN 1 ELSE 0 END AS qbo_named_observations_predecessor_guard;

CREATE TABLE accounting_qbo_named_observations (
  id uuid PRIMARY KEY,
  observation_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type text NOT NULL CHECK (object_type IN ('Customer','Vendor','Employee')),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) > 0),
  object_version varchar(120) NOT NULL CHECK (length(btrim(object_version)) > 0),
  source_object_id uuid NOT NULL,
  provider_updated_at timestamptz,
  body_hash varchar(64) NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  provider_body jsonb NOT NULL CHECK (jsonb_typeof(provider_body) = 'object'),
  material_conflict boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, legal_entity_id, environment, realm_id, source_object_id)
    REFERENCES accounting_qbo_source_objects(organization_id, legal_entity_id, environment, realm_id, id)
);
CREATE INDEX accounting_qbo_named_observations_latest
  ON accounting_qbo_named_observations
    (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, observed_at DESC, observation_order DESC);

CREATE OR REPLACE FUNCTION accounting_qbo_named_observation_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accounting_qbo_named_observations_are_append_only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER accounting_qbo_named_observations_immutable
  BEFORE UPDATE OR DELETE ON accounting_qbo_named_observations
  FOR EACH ROW EXECUTE FUNCTION accounting_qbo_named_observation_immutable();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (54, '__RENT_OPS_V54_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 54 AND checksum_sha256 = '__RENT_OPS_V54_CHECKSUM__'
) THEN 1 ELSE 0 END AS qbo_named_observations_checksum_guard;
