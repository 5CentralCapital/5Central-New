-- Versioned forecast scenarios. Assumption versions and snapshots are
-- immutable so a snapshot reproduces exactly from model + assumption + source
-- fingerprints. Forecasts are never posted to QuickBooks.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 47 AND checksum_sha256 = '__RENT_OPS_V47_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_forecasting_predecessor_guard;

CREATE TABLE company_forecast_scenarios (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('base','downside','upside','hold','sell','refinance','custom')),
  state text NOT NULL CHECK (state IN ('draft','approved','archived')),
  base_scenario_id uuid,
  start_date date NOT NULL,
  horizon_weeks integer NOT NULL DEFAULT 13 CHECK (horizon_weeks BETWEEN 1 AND 104),
  horizon_months integer NOT NULL DEFAULT 36 CHECK (horizon_months BETWEEN 1 AND 360),
  reserve_floor_cents bigint NOT NULL DEFAULT 0 CHECK (reserve_floor_cents >= 0),
  currency varchar(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  current_assumption_version integer NOT NULL DEFAULT 0 CHECK (current_assumption_version >= 0),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_by varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, base_scenario_id) REFERENCES company_forecast_scenarios(organization_id, id),
  CHECK ((state = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX company_forecast_scenarios_name
  ON company_forecast_scenarios (organization_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE company_forecast_assumption_versions (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  scenario_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  assumptions jsonb NOT NULL CHECK (jsonb_typeof(assumptions) = 'object'),
  assumptions_sha256 varchar(64) NOT NULL CHECK (assumptions_sha256 ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  author_id varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, scenario_id, version),
  FOREIGN KEY (organization_id, scenario_id) REFERENCES company_forecast_scenarios(organization_id, id)
);

CREATE TABLE company_forecast_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  scenario_id uuid NOT NULL,
  assumption_version integer NOT NULL,
  model_version varchar(40) NOT NULL,
  actuals_cutoff date NOT NULL,
  source_fingerprint varchar(64) NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  result_sha256 varchar(64) NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  label text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 160),
  created_by varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, scenario_id, assumption_version)
    REFERENCES company_forecast_assumption_versions(organization_id, scenario_id, version)
);
CREATE INDEX company_forecast_snapshots_scenario
  ON company_forecast_snapshots (organization_id, scenario_id, created_at DESC, id DESC);

-- Approval pins the exact snapshot (model, assumption version and sources)
-- that was reviewed. Editing assumptions returns the scenario to draft.
ALTER TABLE company_forecast_scenarios
  ADD COLUMN approved_snapshot_id uuid,
  ADD COLUMN approved_by varchar(160),
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT company_forecast_scenarios_approved_snapshot
    FOREIGN KEY (organization_id, approved_snapshot_id) REFERENCES company_forecast_snapshots(organization_id, id),
  ADD CONSTRAINT company_forecast_scenarios_approval_complete
    CHECK ((approved_snapshot_id IS NULL) = (approved_by IS NULL) AND (approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT company_forecast_scenarios_approved_state
    CHECK (state <> 'approved' OR approved_snapshot_id IS NOT NULL);
CREATE INDEX company_forecast_scenarios_list
  ON company_forecast_scenarios (organization_id, updated_at DESC, id DESC);

CREATE FUNCTION company_guard_forecast_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'company_forecast_history_is_immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER company_forecast_assumption_history
  BEFORE UPDATE OR DELETE ON company_forecast_assumption_versions
  FOR EACH ROW EXECUTE FUNCTION company_guard_forecast_history();
CREATE TRIGGER company_forecast_snapshot_history
  BEFORE UPDATE OR DELETE ON company_forecast_snapshots
  FOR EACH ROW EXECUTE FUNCTION company_guard_forecast_history();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (48, '__RENT_OPS_V48_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 48 AND checksum_sha256 = '__RENT_OPS_V48_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_forecasting_checksum_guard;
