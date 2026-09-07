-- Rent Operations verified document storage (additive, operator-applied only).
-- This migration is intentionally separate from the rendered v1-v3 ledger.
-- Transfer and immutable object verification must complete before the
-- application writes the document row and this binding in one transaction.

-- v4 is only valid on the exact v3 schema.  The renderer replaces the
-- placeholder with the source checksum before an operator applies this SQL.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v3_checksum_guard;

ALTER TABLE rent_ops_documents ALTER COLUMN type DROP NOT NULL;
ALTER TABLE rent_ops_documents ALTER COLUMN state DROP NOT NULL;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS type_knowledge text;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS state_knowledge text;

ALTER TABLE rent_ops_documents DROP CONSTRAINT IF EXISTS rent_ops_documents_v3_metadata_state;
ALTER TABLE rent_ops_documents DROP CONSTRAINT IF EXISTS rent_ops_documents_verified_availability;
ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_verified_availability
  CHECK (availability IS NULL OR availability IN ('metadata', 'requested', 'unavailable', 'verified'));

CREATE TABLE IF NOT EXISTS rent_ops_document_objects (
  document_id varchar(160) PRIMARY KEY REFERENCES rent_ops_documents(id),
  binding_kind text NOT NULL DEFAULT 'applicant' CHECK (binding_kind IN ('applicant', 'import')),
  source_binary_id varchar(160),
  import_run_id varchar(160),
  source_system text,
  source_collection text,
  backend text NOT NULL CHECK (length(backend) > 0),
  logical_key text NOT NULL CHECK (logical_key ~ '^sha256:[a-f0-9]{64}$'),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  immutable_generation text,
  immutable_version text,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_document_objects_exact_version
    CHECK (immutable_generation IS NOT NULL OR immutable_version IS NOT NULL),
  CONSTRAINT rent_ops_document_objects_binding_domain
    CHECK (
      (binding_kind = 'applicant' AND source_binary_id IS NULL AND import_run_id IS NULL)
      OR
      (binding_kind = 'import' AND source_binary_id IS NOT NULL AND import_run_id IS NOT NULL AND source_system IS NOT NULL AND source_collection IS NOT NULL)
    ),
  CONSTRAINT rent_ops_document_objects_key_checksum
    CHECK (substring(logical_key FROM 8) = checksum_sha256)
);

ALTER TABLE rent_ops_document_objects ADD COLUMN IF NOT EXISTS binding_kind text NOT NULL DEFAULT 'applicant';
ALTER TABLE rent_ops_document_objects ADD COLUMN IF NOT EXISTS source_binary_id varchar(160);
ALTER TABLE rent_ops_document_objects ADD COLUMN IF NOT EXISTS import_run_id varchar(160);
ALTER TABLE rent_ops_document_objects ADD COLUMN IF NOT EXISTS source_system text;
ALTER TABLE rent_ops_document_objects ADD COLUMN IF NOT EXISTS source_collection text;
ALTER TABLE rent_ops_document_objects DROP CONSTRAINT IF EXISTS rent_ops_document_objects_binding_domain;
ALTER TABLE rent_ops_document_objects ADD CONSTRAINT rent_ops_document_objects_binding_domain
  CHECK (
    (binding_kind = 'applicant' AND source_binary_id IS NULL AND import_run_id IS NULL AND source_system IS NULL AND source_collection IS NULL)
    OR
    (binding_kind = 'import' AND source_binary_id IS NOT NULL AND import_run_id IS NOT NULL AND source_system IS NOT NULL AND source_collection IS NOT NULL)
  );
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_document_objects_source_binary_fk') THEN
    ALTER TABLE rent_ops_document_objects ADD CONSTRAINT rent_ops_document_objects_source_binary_fk
      FOREIGN KEY (source_binary_id) REFERENCES rent_ops_source_binaries(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_document_objects_import_run_fk') THEN
    ALTER TABLE rent_ops_document_objects ADD CONSTRAINT rent_ops_document_objects_import_run_fk
      FOREIGN KEY (import_run_id) REFERENCES rent_ops_import_runs(id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rent_ops_guard_document_object_source_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_run_id varchar(160);
  source_system_value text;
  source_collection_value text;
  source_checksum varchar(64);
  source_size integer;
  source_status text;
BEGIN
  IF NEW.binding_kind = 'import' THEN
    SELECT import_run_id, system, source_collection, checksum_sha256, size_bytes, verification_status
      INTO source_run_id, source_system_value, source_collection_value, source_checksum, source_size, source_status
      FROM rent_ops_source_binaries
      WHERE id = NEW.source_binary_id;
    IF source_run_id IS NULL OR source_run_id IS DISTINCT FROM NEW.import_run_id
      OR source_system_value IS DISTINCT FROM NEW.source_system
      OR source_collection_value IS DISTINCT FROM NEW.source_collection
      OR source_checksum IS DISTINCT FROM NEW.checksum_sha256
      OR source_size IS DISTINCT FROM NEW.size_bytes
      OR source_status IS DISTINCT FROM 'verified' THEN
      RAISE EXCEPTION 'import document binding must match its exact verified source binary';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rent_ops_document_objects_source_binding_guard ON rent_ops_document_objects;
CREATE TRIGGER rent_ops_document_objects_source_binding_guard
  BEFORE INSERT OR UPDATE ON rent_ops_document_objects
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_document_object_source_binding();

-- Multiple documents may safely reference the same immutable content object;
-- the binding is unique per document, not per object generation.
CREATE INDEX IF NOT EXISTS rent_ops_document_objects_object_index
  ON rent_ops_document_objects (backend, logical_key, immutable_generation, immutable_version);

CREATE OR REPLACE FUNCTION rent_ops_guard_document_object_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.binding_kind IS DISTINCT FROM OLD.binding_kind
    OR NEW.source_binary_id IS DISTINCT FROM OLD.source_binary_id
    OR NEW.import_run_id IS DISTINCT FROM OLD.import_run_id
    OR NEW.source_system IS DISTINCT FROM OLD.source_system
    OR NEW.source_collection IS DISTINCT FROM OLD.source_collection
    OR NEW.backend IS DISTINCT FROM OLD.backend
    OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
    OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.immutable_generation IS DISTINCT FROM OLD.immutable_generation
    OR NEW.immutable_version IS DISTINCT FROM OLD.immutable_version
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'verified document object binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rent_ops_document_objects_immutable_guard ON rent_ops_document_objects;
CREATE TRIGGER rent_ops_document_objects_immutable_guard
  BEFORE UPDATE ON rent_ops_document_objects
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_document_object_binding();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (1, '__RENT_OPS_V1_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (2, '__RENT_OPS_V2_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (3, '__RENT_OPS_V3_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (4, '__RENT_OPS_V4_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v4_post_insert_checksum_guard;
