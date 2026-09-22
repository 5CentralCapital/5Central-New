-- Employee time source records, review, costing and provider connection state.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 35 AND checksum_sha256 = '__RENT_OPS_V35_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_employee_time_predecessor_guard;

CREATE TABLE time_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','needs_reconnect')),
  access_token_ciphertext bytea,
  access_token_iv bytea,
  access_token_auth_tag bytea,
  refresh_token_ciphertext bytea,
  refresh_token_iv bytea,
  refresh_token_auth_tag bytea,
  token_type varchar(40) NOT NULL DEFAULT 'bearer',
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  token_version bigint NOT NULL DEFAULT 1 CHECK (token_version > 0),
  provider_scopes text[] NOT NULL DEFAULT '{}',
  provider_trace_id varchar(255),
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK ((access_token_ciphertext IS NULL AND access_token_iv IS NULL AND access_token_auth_tag IS NULL)
      OR (access_token_ciphertext IS NOT NULL AND access_token_iv IS NOT NULL AND access_token_auth_tag IS NOT NULL)),
  CHECK ((refresh_token_ciphertext IS NULL AND refresh_token_iv IS NULL AND refresh_token_auth_tag IS NULL)
      OR (refresh_token_ciphertext IS NOT NULL AND refresh_token_iv IS NOT NULL AND refresh_token_auth_tag IS NOT NULL)),
  CHECK (status = 'active' OR revoked_at IS NOT NULL),
  CHECK (status = 'active' OR access_token_ciphertext IS NULL),
  CHECK (status = 'active' OR refresh_token_ciphertext IS NULL)
);
CREATE INDEX time_connections_scope ON time_connections (organization_id, legal_entity_id, environment, provider_company_id);

CREATE TABLE time_refresh_leases (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  owner_id varchar(160) NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  lease_until timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organization_id, legal_entity_id, environment, provider_company_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

CREATE TABLE time_oauth_states (
  id uuid PRIMARY KEY,
  state_hash varchar(64) NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) CHECK (provider_company_id IS NULL OR provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  actor_id varchar(255) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  session_binding_hash varchar(64) NOT NULL CHECK (session_binding_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

CREATE TABLE time_sync_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  idempotency_key varchar(255) NOT NULL,
  status text NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  error_code varchar(120),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, idempotency_key),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);

CREATE TABLE time_sync_checkpoints (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  stream text NOT NULL CHECK (stream IN ('users','jobcodes','timesheets','timesheets_deleted')),
  modified_since timestamptz,
  watermark timestamptz,
  status text NOT NULL DEFAULT 'unavailable' CHECK (status IN ('unavailable','partial','complete')),
  last_run_id uuid,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, legal_entity_id, environment, provider_company_id, stream),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, last_run_id) REFERENCES time_sync_runs(organization_id, id)
);

CREATE TABLE time_source_users (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_user_id varchar(160) NOT NULL,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  display_name text NOT NULL,
  email text,
  active boolean NOT NULL DEFAULT true,
  submitted_to date,
  approved_to date,
  last_modified timestamptz NOT NULL,
  provider_body jsonb NOT NULL CHECK (jsonb_typeof(provider_body) = 'object'),
  source_version varchar(160) NOT NULL,
  body_hash varchar(64) NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_user_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX time_source_users_scope ON time_source_users (organization_id, legal_entity_id, environment, provider_company_id, display_name, id);

CREATE TABLE time_source_jobcodes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_jobcode_id varchar(160) NOT NULL,
  name text NOT NULL,
  parent_id varchar(160),
  provider_type varchar(80) NOT NULL DEFAULT '',
  billable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  last_modified timestamptz NOT NULL,
  provider_body jsonb NOT NULL CHECK (jsonb_typeof(provider_body) = 'object'),
  source_version varchar(160) NOT NULL,
  body_hash varchar(64) NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_jobcode_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX time_source_jobcodes_scope ON time_source_jobcodes (organization_id, legal_entity_id, environment, provider_company_id, name, id);

CREATE TABLE time_timesheet_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_timesheet_id varchar(160) NOT NULL,
  source_version varchar(160) NOT NULL,
  provider_user_id varchar(160) NOT NULL,
  provider_jobcode_id varchar(160) NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('regular','manual')),
  start_at timestamptz,
  end_at timestamptz,
  start_local text,
  end_local text,
  entry_date date NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  timezone_offset_minutes integer CHECK (timezone_offset_minutes BETWEEN -1440 AND 1440),
  timezone_name varchar(80),
  on_the_clock boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  provider_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  notes text NOT NULL DEFAULT '',
  last_modified timestamptz NOT NULL,
  provider_body jsonb NOT NULL CHECK (jsonb_typeof(provider_body) = 'object'),
  body_hash varchar(64) NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_timesheet_id, source_version),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK ((entry_type = 'regular' AND start_at IS NOT NULL AND (end_at IS NULL OR end_at > start_at) AND start_local IS NOT NULL)
      OR (entry_type = 'manual' AND start_at IS NULL AND end_at IS NULL AND start_local IS NULL AND end_local IS NULL))
);

CREATE TABLE time_timesheets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_timesheet_id varchar(160) NOT NULL,
  current_revision_id uuid NOT NULL REFERENCES time_timesheet_revisions(id),
  provider_user_id varchar(160) NOT NULL,
  provider_jobcode_id varchar(160) NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('regular','manual')),
  start_at timestamptz,
  end_at timestamptz,
  start_local text,
  end_local text,
  entry_date date NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  timezone_offset_minutes integer CHECK (timezone_offset_minutes BETWEEN -1440 AND 1440),
  timezone_name varchar(80),
  on_the_clock boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  provider_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  notes text NOT NULL DEFAULT '',
  last_modified timestamptz NOT NULL,
  review_state text NOT NULL DEFAULT 'needs_review' CHECK (review_state IN ('needs_review','corrected','approved','rejected')),
  conflict text NOT NULL DEFAULT 'none' CHECK (conflict IN ('none','overlap','multiple_active','invalid_duration','stale_correction')),
  correction_revision integer NOT NULL DEFAULT 0 CHECK (correction_revision >= 0),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_timesheet_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, current_revision_id) REFERENCES time_timesheet_revisions(organization_id, id),
  CHECK ((entry_type = 'regular' AND start_at IS NOT NULL AND (end_at IS NULL OR end_at > start_at) AND start_local IS NOT NULL)
      OR (entry_type = 'manual' AND start_at IS NULL AND end_at IS NULL AND start_local IS NULL AND end_local IS NULL))
);
CREATE UNIQUE INDEX time_timesheets_one_active_user ON time_timesheets (organization_id, legal_entity_id, environment, provider_company_id, provider_user_id)
  WHERE provider_active AND on_the_clock AND deleted_at IS NULL;
CREATE INDEX time_timesheets_review ON time_timesheets (organization_id, legal_entity_id, environment, provider_company_id, review_state, entry_date, id);
CREATE INDEX time_timesheets_date ON time_timesheets (organization_id, legal_entity_id, environment, provider_company_id, entry_date, last_modified, id);

-- A deleted provider object can arrive before its live timesheet page. Keep a
-- bounded source tombstone so a later sync cannot silently recreate it and the
-- deletion remains auditable without exposing provider credentials.
CREATE TABLE time_timesheet_deletion_tombstones (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_timesheet_id varchar(160) NOT NULL,
  source_version varchar(160) NOT NULL,
  body_hash varchar(64) NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  provider_body jsonb NOT NULL CHECK (jsonb_typeof(provider_body) = 'object'),
  deleted_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_timesheet_id, source_version),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE INDEX time_timesheet_deletion_tombstones_scope ON time_timesheet_deletion_tombstones (organization_id, legal_entity_id, environment, provider_company_id, deleted_at DESC, id);

CREATE TABLE time_timesheet_corrections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  timesheet_id uuid NOT NULL,
  correction_revision integer NOT NULL CHECK (correction_revision > 0),
  entry_type text NOT NULL CHECK (entry_type IN ('regular','manual')),
  start_at timestamptz,
  end_at timestamptz,
  start_local text,
  end_local text,
  entry_date date NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  timezone_offset_minutes integer CHECK (timezone_offset_minutes BETWEEN -1440 AND 1440),
  timezone_name varchar(80),
  notes text NOT NULL DEFAULT '',
  reason text NOT NULL,
  actor_id varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, timesheet_id, correction_revision),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, timesheet_id) REFERENCES time_timesheets(organization_id, id),
  CHECK ((entry_type = 'regular' AND start_at IS NOT NULL AND (end_at IS NULL OR end_at > start_at) AND start_local IS NOT NULL)
      OR (entry_type = 'manual' AND start_at IS NULL AND end_at IS NULL AND start_local IS NULL AND end_local IS NULL))
);

CREATE TABLE time_employee_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_user_id varchar(160) NOT NULL,
  contact_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  hourly_rate_cents bigint CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
  currency varchar(3),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_user_id, effective_from),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES company_contacts(organization_id, id),
  CHECK ((hourly_rate_cents IS NULL AND currency IS NULL) OR (hourly_rate_cents IS NOT NULL AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$')),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX time_employee_mappings_current ON time_employee_mappings (organization_id, legal_entity_id, environment, provider_company_id, provider_user_id, effective_from DESC);

CREATE TABLE time_jobcode_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  provider_company_id varchar(160) NOT NULL CHECK (provider_company_id ~ '^[A-Za-z0-9_.:-]+$'),
  provider_jobcode_id varchar(160) NOT NULL,
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  project_id uuid,
  cost_code varchar(160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, legal_entity_id, environment, provider_company_id, provider_jobcode_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id)
);

CREATE TABLE time_labor_estimates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  timesheet_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  hourly_rate_cents bigint NOT NULL CHECK (hourly_rate_cents >= 0),
  labor_cost_cents bigint NOT NULL CHECK (labor_cost_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  basis text NOT NULL DEFAULT 'estimated_time_rate' CHECK (basis = 'estimated_time_rate'),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, timesheet_id),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, timesheet_id) REFERENCES time_timesheets(organization_id, id),
  FOREIGN KEY (organization_id, mapping_id) REFERENCES time_employee_mappings(organization_id, id)
);

CREATE TABLE time_posted_payroll_sources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  timesheet_id uuid,
  source_kind varchar(80) NOT NULL,
  source_reference varchar(255) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  posted_on date NOT NULL,
  evidence_state text NOT NULL CHECK (evidence_state IN ('unverified','verified')),
  provider_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_kind, source_reference),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, timesheet_id) REFERENCES time_timesheets(organization_id, id)
);

CREATE TABLE time_review_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  timesheet_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('request_review','correct','approve','reject','map_employee','map_jobcode')),
  from_state text,
  to_state text,
  operation_id uuid,
  actor_id varchar(255) NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, timesheet_id) REFERENCES time_timesheets(organization_id, id)
);
CREATE INDEX time_review_events_entry ON time_review_events (organization_id, timesheet_id, created_at DESC, id);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (36, '__RENT_OPS_V36_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 36 AND checksum_sha256 = '__RENT_OPS_V36_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_employee_time_checksum_guard;
