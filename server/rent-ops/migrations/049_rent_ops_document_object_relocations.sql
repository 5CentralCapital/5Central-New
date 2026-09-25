-- Verified document object relocations (append-only).
--
-- A verified document binding pins one exact backend object version and is
-- immutable (see 004). Moving storage providers (Replit-managed GCS to the
-- private versioned S3 bucket) therefore records a relocation instead of
-- rewriting the binding: each row says the same content (same logical key,
-- checksum and size) is now held at an exact version in another backend.
-- The effective binding is the original row overlaid with its latest
-- relocation. Rows are written only by the reviewed relocation operator after
-- the target object was copied and verified; they are never updated or
-- deleted, so the original provider identity stays auditable.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 48 AND checksum_sha256 = '__RENT_OPS_V48_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_document_relocation_predecessor_guard;

CREATE TABLE rent_ops_document_object_relocations (
  document_id varchar(160) NOT NULL REFERENCES rent_ops_document_objects(document_id),
  relocation_sequence integer NOT NULL CHECK (relocation_sequence BETWEEN 1 AND 100),
  relocation_run_id varchar(160) NOT NULL CHECK (relocation_run_id ~ '^[A-Za-z0-9_.:-]{3,160}$'),
  from_backend text NOT NULL CHECK (length(from_backend) BETWEEN 1 AND 80),
  from_immutable_generation text,
  from_immutable_version text,
  to_backend text NOT NULL CHECK (length(to_backend) BETWEEN 1 AND 80),
  to_immutable_generation text CHECK (to_immutable_generation IS NULL OR length(to_immutable_generation) BETWEEN 1 AND 256),
  to_immutable_version text CHECK (to_immutable_version IS NULL OR length(to_immutable_version) BETWEEN 1 AND 256),
  logical_key text NOT NULL CHECK (logical_key ~ '^sha256:[a-f0-9]{64}$'),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  verified_at timestamptz NOT NULL,
  plan_sha256 varchar(64) NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_reference varchar(160) NOT NULL CHECK (authorization_reference ~ '^[A-Za-z0-9_.:/-]{3,160}$'),
  recorded_by text NOT NULL DEFAULT current_user,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, relocation_sequence),
  CONSTRAINT rent_ops_document_object_relocations_target_version
    CHECK (to_immutable_generation IS NOT NULL OR to_immutable_version IS NOT NULL),
  CONSTRAINT rent_ops_document_object_relocations_source_version
    CHECK (from_immutable_generation IS NOT NULL OR from_immutable_version IS NOT NULL),
  CONSTRAINT rent_ops_document_object_relocations_key_checksum
    CHECK (substring(logical_key FROM 8) = checksum_sha256),
  CONSTRAINT rent_ops_document_object_relocations_moves
    CHECK (
      to_backend IS DISTINCT FROM from_backend
      OR to_immutable_generation IS DISTINCT FROM from_immutable_generation
      OR to_immutable_version IS DISTINCT FROM from_immutable_version
    )
);

CREATE INDEX rent_ops_document_object_relocations_target
  ON rent_ops_document_object_relocations (to_backend, logical_key, to_immutable_version);
CREATE INDEX rent_ops_document_object_relocations_run
  ON rent_ops_document_object_relocations (relocation_run_id);

-- A relocation must continue the exact chain: same content as the original
-- binding, starting from the currently effective backend object, next in
-- sequence. Concurrent writers collide on the primary key.
CREATE FUNCTION rent_ops_guard_document_object_relocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  base rent_ops_document_objects%ROWTYPE;
  latest rent_ops_document_object_relocations%ROWTYPE;
  current_backend text;
  current_generation text;
  current_version text;
BEGIN
  SELECT * INTO base FROM rent_ops_document_objects WHERE document_id = NEW.document_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rent_ops_document_relocation_binding_missing' USING ERRCODE = '23503';
  END IF;
  IF NEW.logical_key IS DISTINCT FROM base.logical_key
    OR NEW.checksum_sha256 IS DISTINCT FROM base.checksum_sha256
    OR NEW.size_bytes IS DISTINCT FROM base.size_bytes THEN
    RAISE EXCEPTION 'rent_ops_document_relocation_content_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO latest FROM rent_ops_document_object_relocations
    WHERE document_id = NEW.document_id
    ORDER BY relocation_sequence DESC
    LIMIT 1;
  IF FOUND THEN
    current_backend := latest.to_backend;
    current_generation := latest.to_immutable_generation;
    current_version := latest.to_immutable_version;
    IF NEW.relocation_sequence IS DISTINCT FROM latest.relocation_sequence + 1 THEN
      RAISE EXCEPTION 'rent_ops_document_relocation_sequence_gap' USING ERRCODE = '23514';
    END IF;
  ELSE
    current_backend := base.backend;
    current_generation := base.immutable_generation;
    current_version := base.immutable_version;
    IF NEW.relocation_sequence IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'rent_ops_document_relocation_sequence_gap' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.from_backend IS DISTINCT FROM current_backend
    OR NEW.from_immutable_generation IS DISTINCT FROM current_generation
    OR NEW.from_immutable_version IS DISTINCT FROM current_version THEN
    RAISE EXCEPTION 'rent_ops_document_relocation_source_stale' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rent_ops_document_object_relocation_chain
  BEFORE INSERT ON rent_ops_document_object_relocations
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_document_object_relocation();

CREATE FUNCTION rent_ops_guard_document_object_relocation_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rent_ops_document_relocation_history_is_immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER rent_ops_document_object_relocation_history
  BEFORE UPDATE OR DELETE ON rent_ops_document_object_relocations
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_document_object_relocation_history();

CREATE TRIGGER rent_ops_document_object_relocation_no_truncate
  BEFORE TRUNCATE ON rent_ops_document_object_relocations
  FOR EACH STATEMENT EXECUTE FUNCTION rent_ops_guard_document_object_relocation_history();

REVOKE ALL PRIVILEGES ON TABLE rent_ops_document_object_relocations FROM PUBLIC;

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (49, '__RENT_OPS_V49_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 49 AND checksum_sha256 = '__RENT_OPS_V49_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_document_relocation_checksum_guard;
