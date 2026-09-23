-- MRA/generic intake packets, per-line outcomes and account control totals.
-- Promoted from server/intake/schema.sql; MRA mutation remains Codex-only.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 42 AND checksum_sha256 = '__RENT_OPS_V42_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_intake_predecessor_guard;

CREATE TABLE company_intake_packets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid,
  property_id varchar(160),
  state text NOT NULL CHECK (state IN ('staged','mapped','previewed','applying','partially_applied','applied','held','failed')),
  source_document_id varchar(160) NOT NULL,
  source_file_name text NOT NULL CHECK (length(btrim(source_file_name)) BETWEEN 1 AND 240),
  source_content_type text NOT NULL CHECK (length(btrim(source_content_type)) BETWEEN 1 AND 120),
  source_size_bytes integer NOT NULL CHECK (source_size_bytes > 0),
  source_checksum_sha256 varchar(64) NOT NULL CHECK (source_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  source_backend text NOT NULL CHECK (length(btrim(source_backend)) > 0),
  source_logical_key text NOT NULL CHECK (source_logical_key = 'sha256:' || source_checksum_sha256),
  source_immutable_generation text,
  source_immutable_version text,
  source_verified_at timestamptz NOT NULL,
  candidate_json jsonb NOT NULL CHECK (jsonb_typeof(candidate_json) = 'object'),
  lines_json jsonb NOT NULL CHECK (jsonb_typeof(lines_json) = 'array'),
  reconciliation_json jsonb CHECK (reconciliation_json IS NULL OR jsonb_typeof(reconciliation_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  mapped_at timestamptz,
  previewed_at timestamptz,
  applied_at timestamptz,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (property_id) REFERENCES rent_ops_properties(id),
  CHECK (property_id IS NULL OR legal_entity_id IS NOT NULL),
  CHECK (source_immutable_generation IS NOT NULL OR source_immutable_version IS NOT NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_checksum_sha256)
);
CREATE INDEX company_intake_packets_scope_updated
  ON company_intake_packets (organization_id, legal_entity_id, property_id, updated_at DESC, id DESC);
CREATE INDEX company_intake_packets_source
  ON company_intake_packets (organization_id, source_checksum_sha256);

CREATE TABLE company_intake_line_registry (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  source_line_key text NOT NULL CHECK (length(btrim(source_line_key)) BETWEEN 1 AND 240),
  packet_id uuid NOT NULL,
  source_checksum_sha256 varchar(64) NOT NULL CHECK (source_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  source_revision text NOT NULL CHECK (length(btrim(source_revision)) BETWEEN 1 AND 120),
  outcome text NOT NULL CHECK (outcome IN ('matched','held_missing_identity','held_ambiguous_identity','held_unsupported','duplicate','overlap','corrected','applied','apply_failed')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_line_key, source_checksum_sha256),
  FOREIGN KEY (organization_id, packet_id) REFERENCES company_intake_packets(organization_id, id)
);
CREATE INDEX company_intake_line_registry_latest
  ON company_intake_line_registry (organization_id, source_line_key, observed_at DESC, packet_id DESC);

CREATE TABLE company_intake_account_outcomes (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  packet_id uuid NOT NULL,
  source_account_id text NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  input_cents bigint NOT NULL,
  matched_cents bigint NOT NULL,
  held_cents bigint NOT NULL,
  duplicate_cents bigint NOT NULL,
  overlap_cents bigint NOT NULL,
  applied_cents bigint NOT NULL,
  line_count integer NOT NULL CHECK (line_count >= 0),
  held_count integer NOT NULL CHECK (held_count >= 0),
  applied_count integer NOT NULL CHECK (applied_count >= 0),
  state text NOT NULL CHECK (state IN ('ready','held','applied','failed')),
  message text,
  PRIMARY KEY (organization_id, packet_id, source_account_id, currency),
  FOREIGN KEY (organization_id, packet_id) REFERENCES company_intake_packets(organization_id, id)
);

CREATE TABLE company_intake_project_cost_candidates (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  source_line_key text NOT NULL,
  project_id uuid NOT NULL,
  scope_item_id uuid,
  source_document_id varchar(160) NOT NULL,
  description text NOT NULL,
  vendor_name text,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  incurred_on date NOT NULL,
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json) = 'array'),
  outcome text NOT NULL CHECK (outcome IN ('new_draft','duplicate','held')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_line_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, scope_item_id) REFERENCES company_project_scope_items(organization_id, id)
);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (43, '__RENT_OPS_V43_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 43 AND checksum_sha256 = '__RENT_OPS_V43_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_intake_checksum_guard;
