-- Evidence-backed review cases replace the generic "Needs review" label.
-- One case per (reason, cause, scope); affected-record counts are separate from
-- case counts. A NULL impact is unknown, never zero. Case history is append-only.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 44 AND checksum_sha256 = '__RENT_OPS_V44_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_review_cases_predecessor_guard;

CREATE TABLE company_review_cases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid,
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  reason_code varchar(80) NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,79}$'),
  cause_key varchar(255) NOT NULL CHECK (length(btrim(cause_key)) > 0),
  scope_key varchar(255) NOT NULL CHECK (length(btrim(scope_key)) > 0),
  scope_label text CHECK (scope_label IS NULL OR length(btrim(scope_label)) BETWEEN 1 AND 240),
  state text NOT NULL CHECK (state IN ('open','researching','proposed','applied','verified','blocked')),
  materiality text NOT NULL CHECK (materiality IN ('high','medium','low','unknown')),
  as_of date NOT NULL,
  impact_cents bigint,
  impact_currency varchar(3) CHECK (impact_currency IS NULL OR impact_currency ~ '^[A-Z]{3}$'),
  affected_records jsonb NOT NULL CHECK (jsonb_typeof(affected_records) = 'array' AND jsonb_array_length(affected_records) <= 500),
  affected_count integer NOT NULL CHECK (affected_count >= 0),
  source_fingerprint varchar(64) NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 200),
  proposed_correction jsonb CHECK (proposed_correction IS NULL OR jsonb_typeof(proposed_correction) = 'object'),
  blocked_on text CHECK (blocked_on IS NULL OR length(btrim(blocked_on)) BETWEEN 1 AND 500),
  detected_by text NOT NULL CHECK (detected_by IN ('detector','manual','intake','accounting')),
  reopened_count integer NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, reason_code, cause_key, scope_key),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  CHECK ((impact_cents IS NULL) = (impact_currency IS NULL)),
  CHECK ((state = 'blocked') = (blocked_on IS NOT NULL)),
  CHECK ((state IN ('applied','verified')) = (resolved_at IS NOT NULL)),
  CHECK (state <> 'proposed' OR proposed_correction IS NOT NULL),
  CHECK (last_detected_at >= first_detected_at)
);
CREATE INDEX company_review_cases_queue
  ON company_review_cases (organization_id, state, materiality, reason_code, updated_at DESC, id)
  WHERE state <> 'verified';
CREATE INDEX company_review_cases_property
  ON company_review_cases (organization_id, property_id, state);

CREATE TABLE company_review_case_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  case_id uuid NOT NULL,
  case_revision integer NOT NULL CHECK (case_revision > 0),
  event_kind text NOT NULL CHECK (event_kind IN ('detected','refreshed','transitioned','proposed','applied','verified','reopened','auto_resolved','note')),
  from_state text,
  to_state text NOT NULL,
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  source_fingerprint varchar(64) NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, case_id, case_revision, event_kind),
  FOREIGN KEY (organization_id, case_id) REFERENCES company_review_cases(organization_id, id)
);
CREATE INDEX company_review_case_events_case
  ON company_review_case_events (organization_id, case_id, occurred_at DESC, id DESC);

CREATE FUNCTION company_guard_review_case_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'company_review_case_history_is_append_only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER company_review_case_events_history
  BEFORE UPDATE OR DELETE ON company_review_case_events
  FOR EACH ROW EXECUTE FUNCTION company_guard_review_case_history();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (45, '__RENT_OPS_V45_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 45 AND checksum_sha256 = '__RENT_OPS_V45_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_review_cases_checksum_guard;
