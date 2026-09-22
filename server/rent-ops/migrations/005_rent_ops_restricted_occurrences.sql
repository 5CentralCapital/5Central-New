-- Rent Operations schema v5 is additive.  The restricted parity ledger keeps
-- the approved archive controls and every source occurrence in order.  The
-- existing source-payload table remains a checksum-version registry; these
-- tables are the append-only occurrence/audit surface beside it.

-- v4 is owned by the storage cutover.  Do not apply v5 over an unverified v4.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v4_checksum_guard;

CREATE TABLE IF NOT EXISTS rent_ops_restricted_parity_observations (
  id varchar(160) PRIMARY KEY,
  version varchar(120) NOT NULL CHECK (length(trim(version)) > 0),
  source varchar(120) NOT NULL CHECK (length(trim(source)) > 0),
  source_run_id varchar(160) NOT NULL CHECK (length(trim(source_run_id)) > 0),
  import_run_id varchar(160) NOT NULL REFERENCES rent_ops_import_runs(id),
  observed_at timestamptz NOT NULL,
  source_envelope_sha256 varchar(64) NOT NULL CHECK (source_envelope_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256 varchar(64) NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_rows_sha256 varchar(64) NOT NULL CHECK (source_rows_sha256 ~ '^[0-9a-f]{64}$'),
  collections_sha256 varchar(64) NOT NULL CHECK (collections_sha256 ~ '^[0-9a-f]{64}$'),
  collection_occurrence_count integer NOT NULL CHECK (collection_occurrence_count >= 0),
  collection_occurrence_order_sha256 varchar(64) NOT NULL CHECK (collection_occurrence_order_sha256 ~ '^[0-9a-f]{64}$'),
  collection_occurrence_set_sha256 varchar(64) NOT NULL CHECK (collection_occurrence_set_sha256 ~ '^[0-9a-f]{64}$'),
  row_occurrence_count integer NOT NULL CHECK (row_occurrence_count >= 0),
  row_occurrence_order_sha256 varchar(64) NOT NULL CHECK (row_occurrence_order_sha256 ~ '^[0-9a-f]{64}$'),
  row_occurrence_set_sha256 varchar(64) NOT NULL CHECK (row_occurrence_set_sha256 ~ '^[0-9a-f]{64}$'),
  source_identity_order_sha256 varchar(64) NOT NULL CHECK (source_identity_order_sha256 ~ '^[0-9a-f]{64}$'),
  source_schema_version varchar(120) NOT NULL CHECK (length(trim(source_schema_version)) > 0),
  source_registry_sha256 varchar(64) CHECK (source_registry_sha256 IS NULL OR source_registry_sha256 ~ '^[0-9a-f]{64}$'),
  source_checkpoint_sha256 varchar(64) CHECK (source_checkpoint_sha256 IS NULL OR source_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  source_coverage_sha256 varchar(64) CHECK (source_coverage_sha256 IS NULL OR source_coverage_sha256 ~ '^[0-9a-f]{64}$'),
  source_control_sha256 varchar(64) NOT NULL CHECK (source_control_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_restricted_parity_observation_binding_unique UNIQUE (source_run_id, import_run_id)
);

CREATE TABLE IF NOT EXISTS rent_ops_restricted_parity_collection_occurrences (
  id varchar(160) PRIMARY KEY,
  observation_id varchar(160) NOT NULL REFERENCES rent_ops_restricted_parity_observations(id) ON DELETE RESTRICT,
  occurrence_ordinal integer NOT NULL CHECK (occurrence_ordinal >= 0),
  path text NOT NULL CHECK (length(trim(path)) > 0),
  present boolean NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  ordered_rows_sha256 varchar(64) NOT NULL CHECK (ordered_rows_sha256 ~ '^[0-9a-f]{64}$'),
  source_identity_rows_sha256 varchar(64) NOT NULL CHECK (source_identity_rows_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rent_ops_restricted_parity_collection_order_unique UNIQUE (observation_id, occurrence_ordinal),
  CONSTRAINT rent_ops_restricted_parity_collection_absent_empty CHECK (present OR row_count = 0)
);

CREATE TABLE IF NOT EXISTS rent_ops_restricted_parity_row_occurrences (
  id varchar(160) PRIMARY KEY,
  observation_id varchar(160) NOT NULL REFERENCES rent_ops_restricted_parity_observations(id) ON DELETE RESTRICT,
  occurrence_ordinal integer NOT NULL CHECK (occurrence_ordinal >= 0),
  collection_occurrence_ordinal integer NOT NULL CHECK (collection_occurrence_ordinal >= 0),
  collection_path text NOT NULL CHECK (length(trim(collection_path)) > 0),
  row_ordinal integer NOT NULL CHECK (row_ordinal >= 0),
  system text NOT NULL CHECK (length(trim(system)) > 0),
  source_collection text NOT NULL CHECK (length(trim(source_collection)) > 0),
  source_id text NOT NULL CHECK (length(trim(source_id)) > 0),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  row_digest_sha256 varchar(64) NOT NULL CHECK (row_digest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rent_ops_restricted_parity_row_order_unique UNIQUE (observation_id, occurrence_ordinal),
  CONSTRAINT rent_ops_restricted_parity_row_collection_binding
    FOREIGN KEY (observation_id, collection_occurrence_ordinal)
    REFERENCES rent_ops_restricted_parity_collection_occurrences(observation_id, occurrence_ordinal)
    ON DELETE RESTRICT,
  CONSTRAINT rent_ops_restricted_parity_row_payload_binding
    FOREIGN KEY (system, source_collection, source_id, checksum_sha256)
    REFERENCES rent_ops_source_payloads(system, source_collection, source_id, checksum_sha256)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS rent_ops_restricted_parity_observation_import_index
  ON rent_ops_restricted_parity_observations(import_run_id);
CREATE INDEX IF NOT EXISTS rent_ops_restricted_parity_collection_observation_index
  ON rent_ops_restricted_parity_collection_occurrences(observation_id, occurrence_ordinal);
CREATE INDEX IF NOT EXISTS rent_ops_restricted_parity_row_observation_index
  ON rent_ops_restricted_parity_row_occurrences(observation_id, occurrence_ordinal);

-- The parity tables contain restricted source identity controls.  PUBLIC and
-- the runtime role receive no implicit access; deployment-security grants
-- SELECT/INSERT only to the importer and SELECT only to the auditor.
REVOKE ALL ON TABLE rent_ops_restricted_parity_observations FROM PUBLIC;
REVOKE ALL ON TABLE rent_ops_restricted_parity_collection_occurrences FROM PUBLIC;
REVOKE ALL ON TABLE rent_ops_restricted_parity_row_occurrences FROM PUBLIC;

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
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (5, '__RENT_OPS_V5_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 5 AND checksum_sha256 = '__RENT_OPS_V5_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v5_post_insert_checksum_guard;
