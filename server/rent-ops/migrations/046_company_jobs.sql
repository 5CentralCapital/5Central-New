-- Durable, database-backed job queue for a separately managed worker.
-- Leases, retries with backoff, unique job keys, checkpoints, dead letters and
-- operator recovery. Outbox events are dispatched into jobs exactly once by key.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 45 AND checksum_sha256 = '__RENT_OPS_V45_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_jobs_predecessor_guard;

CREATE TABLE company_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES company_organizations(id),
  job_key varchar(255) NOT NULL UNIQUE CHECK (length(btrim(job_key)) > 0),
  topic varchar(120) NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.-]*$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL CHECK (state IN ('queued','running','retry','succeeded','dead','cancelled')),
  priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(160),
  lease_until timestamptz,
  checkpoint jsonb CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint) = 'object'),
  last_error_code varchar(120),
  last_error_message text CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  outbox_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state IN ('succeeded','dead','cancelled')) = (finished_at IS NOT NULL))
);
CREATE INDEX company_jobs_ready ON company_jobs (priority, run_after, created_at, id)
  WHERE state IN ('queued','retry');
CREATE INDEX company_jobs_expired_leases ON company_jobs (lease_until) WHERE state = 'running';
CREATE INDEX company_jobs_topic_state ON company_jobs (topic, state, updated_at DESC);
CREATE UNIQUE INDEX company_jobs_outbox_event ON company_jobs (outbox_event_id) WHERE outbox_event_id IS NOT NULL;
CREATE INDEX company_jobs_organization_updated ON company_jobs (organization_id, updated_at DESC, id DESC);
-- Pending object-fetch jobs coalesce by an explicit key carried in the payload.
CREATE INDEX company_jobs_pending_coalesce ON company_jobs (topic, (payload->>'coalesceKey'))
  WHERE state IN ('queued','retry');

CREATE TABLE company_job_attempts (
  job_id uuid NOT NULL REFERENCES company_jobs(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_owner varchar(160) NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded','retry','dead','lease_expired','cancelled')),
  error_code varchar(120),
  PRIMARY KEY (job_id, attempt)
);

CREATE TABLE company_worker_heartbeats (
  worker_id varchar(160) PRIMARY KEY,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  release varchar(120),
  topics text[] NOT NULL DEFAULT '{}'
);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (46, '__RENT_OPS_V46_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 46 AND checksum_sha256 = '__RENT_OPS_V46_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_jobs_checksum_guard;
