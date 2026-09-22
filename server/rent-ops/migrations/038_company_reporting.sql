-- Durable report runs, rows, drilldowns, presets and reporting packages.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 37 AND checksum_sha256 = '__RENT_OPS_V37_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_reporting_predecessor_guard;

CREATE TABLE company_report_runs (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  actor_id text NOT NULL CHECK (length(actor_id) > 0),
  permission_fingerprint text NOT NULL CHECK (permission_fingerprint ~ '^[a-f0-9]{64}$'),
  report_id text NOT NULL CHECK (report_id ~ '^[a-z][a-z0-9-]{1,119}$'),
  definition_version text NOT NULL CHECK (definition_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  state text NOT NULL CHECK (state IN ('ready','failed','expired')),
  generated_at timestamptz NOT NULL,
  expires_at timestamptz,
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'id' = id::text, false)
    AND COALESCE(payload->>'snapshotId' = snapshot_id::text, false)
    AND COALESCE(payload->>'organizationId' = organization_id::text, false)
    AND COALESCE(payload->>'actorId' = actor_id, false)
    AND COALESCE(payload->>'reportId' = report_id, false)
    AND COALESCE(payload->>'definitionVersion' = definition_version, false)
    AND COALESCE(payload->>'state' = state, false)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE INDEX company_report_runs_org_generated_idx ON company_report_runs (organization_id, generated_at DESC);
CREATE UNIQUE INDEX company_report_runs_request_idx
  ON company_report_runs (organization_id, actor_id, (payload->>'requestId'));
CREATE TABLE company_report_run_rows (
  run_id uuid NOT NULL REFERENCES company_report_runs(id),
  row_index integer NOT NULL CHECK (row_index >= 0),
  row_id text NOT NULL CHECK (length(row_id) > 0),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'rowId' = row_id, false)
  ),
  PRIMARY KEY (run_id, row_index),
  UNIQUE (run_id, row_id)
);
CREATE INDEX company_report_run_rows_page_idx ON company_report_run_rows (run_id, row_index);
CREATE TABLE company_report_run_drilldowns (
  run_id uuid NOT NULL REFERENCES company_report_runs(id),
  row_id text NOT NULL CHECK (length(row_id) > 0),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'rowId' = row_id, false)
  ),
  PRIMARY KEY (run_id, row_id)
);

CREATE TABLE company_report_exports (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  actor_id text NOT NULL CHECK (length(actor_id) > 0),
  permission_fingerprint text NOT NULL CHECK (permission_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('queued','running','ready','failed','cancelled','expired')),
  format text NOT NULL CHECK (format IN ('csv','json','html')),
  file_name text NOT NULL,
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'id' = id::text, false)
    AND COALESCE(payload->>'runId' = run_id::text, false)
    AND COALESCE(payload->>'organizationId' = organization_id::text, false)
    AND COALESCE(payload->>'actorId' = actor_id, false)
    AND COALESCE(payload->>'state' = state, false)
    AND COALESCE(payload->>'format' = format, false)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, organization_id) REFERENCES company_report_runs(id, organization_id)
);
CREATE INDEX company_report_exports_org_created_idx ON company_report_exports (organization_id, created_at DESC);

CREATE TABLE company_report_presets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  owner_actor_id text NOT NULL CHECK (length(owner_actor_id) > 0),
  visibility text NOT NULL CHECK (visibility IN ('private','shared')),
  report_id text NOT NULL CHECK (report_id ~ '^[a-z][a-z0-9-]{1,119}$'),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'id' = id::text, false)
    AND COALESCE(payload->>'organizationId' = organization_id::text, false)
    AND COALESCE(payload->>'ownerActorId' = owner_actor_id, false)
    AND COALESCE(payload->>'visibility' = visibility, false)
    AND COALESCE(payload->>'reportId' = report_id, false)
    AND COALESCE((payload->>'revision')::integer = revision, false)
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, organization_id)
);
CREATE INDEX company_report_presets_org_visibility_idx ON company_report_presets (organization_id, visibility, owner_actor_id);
CREATE TABLE company_report_preset_revisions (
  preset_id uuid NOT NULL REFERENCES company_report_presets(id),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE((payload->>'revision')::integer = revision, false)
  ),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (preset_id, revision)
);

CREATE TABLE company_report_packages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  owner_actor_id text NOT NULL CHECK (length(owner_actor_id) > 0),
  visibility text NOT NULL CHECK (visibility IN ('private','shared')),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'id' = id::text, false)
    AND COALESCE(payload->>'organizationId' = organization_id::text, false)
    AND COALESCE(payload->>'ownerActorId' = owner_actor_id, false)
    AND COALESCE(payload->>'visibility' = visibility, false)
    AND COALESCE((payload->>'revision')::integer = revision, false)
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, organization_id)
);
CREATE INDEX company_report_packages_org_visibility_idx ON company_report_packages (organization_id, visibility, owner_actor_id);
CREATE TABLE company_report_package_revisions (
  package_id uuid NOT NULL REFERENCES company_report_packages(id),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE((payload->>'revision')::integer = revision, false)
  ),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (package_id, revision)
);

CREATE TABLE company_report_package_runs (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  actor_id text NOT NULL CHECK (length(actor_id) > 0),
  permission_fingerprint text NOT NULL CHECK (permission_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('queued','running','ready','failed','cancelled','expired')),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND COALESCE(payload->>'id' = id::text, false)
    AND COALESCE(payload->>'packageId' = package_id::text, false)
    AND COALESCE(payload->>'organizationId' = organization_id::text, false)
    AND COALESCE(payload->>'actorId' = actor_id, false)
    AND COALESCE(payload->>'state' = state, false)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, organization_id) REFERENCES company_report_packages(id, organization_id)
);
CREATE INDEX company_report_package_runs_org_created_idx ON company_report_package_runs (organization_id, created_at DESC);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (38, '__RENT_OPS_V38_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 38 AND checksum_sha256 = '__RENT_OPS_V38_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_reporting_checksum_guard;
