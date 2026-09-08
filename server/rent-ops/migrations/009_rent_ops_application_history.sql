-- Rent Operations v9: immutable historical prospect/application case
-- projection.  This migration is additive and never rewrites 001-008.
-- Source values that are not explicitly allowlisted stay in restricted
-- aggregates; templates/fields are definitions and create no instances.

CREATE TABLE IF NOT EXISTS rent_ops_prospects (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  person_id varchar(160) REFERENCES rent_ops_people(id),
  person_link_knowledge text,
  contact_id varchar(160),
  contact_link_knowledge text,
  first_name text,
  last_name text,
  email text,
  phone text,
  status text,
  status_knowledge text NOT NULL,
  created_on date,
  created_on_knowledge text NOT NULL,
  updated_on date,
  updated_on_knowledge text NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_prospects_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_prospects_source_pair_check CHECK ((source_system IS NULL) = (source_id IS NULL)),
  CONSTRAINT rent_ops_prospects_link_knowledge_check CHECK (person_id IS NULL OR person_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_prospects_contact_link_knowledge_check CHECK (contact_id IS NULL OR contact_link_knowledge IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS rent_ops_application_history (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  person_id varchar(160) REFERENCES rent_ops_people(id),
  person_link_knowledge text,
  first_name text,
  last_name text,
  email text,
  phone text,
  status text,
  status_knowledge text NOT NULL,
  submitted_on date,
  submitted_on_knowledge text NOT NULL,
  created_on date,
  created_on_knowledge text NOT NULL,
  updated_on date,
  updated_on_knowledge text NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_history_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_history_status_check CHECK (status IS NULL OR status IN ('draft','submitted','missing_information','under_review','approved','declined','withdrawn','converted')),
  CONSTRAINT rent_ops_application_history_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_history_person_link_check CHECK (person_id IS NULL OR person_link_knowledge IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS rent_ops_application_history_prospect_index
  ON rent_ops_application_history(prospect_id);

CREATE TABLE IF NOT EXISTS rent_ops_application_interests (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  application_link_knowledge text,
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  property_link_knowledge text,
  unit_id varchar(160) REFERENCES rent_ops_units(id),
  unit_link_knowledge text,
  source_order integer,
  source_rank integer,
  preference text,
  preference_knowledge text NOT NULL,
  interested_on date,
  interested_on_knowledge text NOT NULL,
  rent_cents integer,
  rent_knowledge text NOT NULL,
  bedrooms integer,
  bedrooms_knowledge text NOT NULL,
  status text,
  status_knowledge text NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_interests_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_interests_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_interests_application_link_check CHECK (application_id IS NULL OR application_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_interests_property_link_check CHECK (property_id IS NULL OR property_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_interests_unit_link_check CHECK (unit_id IS NULL OR unit_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_interests_source_order_check CHECK (source_order IS NULL OR source_order >= 0),
  CONSTRAINT rent_ops_application_interests_source_rank_check CHECK (source_rank IS NULL OR source_rank >= 0),
  CONSTRAINT rent_ops_application_interests_rent_check CHECK (rent_cents IS NULL OR rent_cents >= 0)
);

CREATE INDEX IF NOT EXISTS rent_ops_application_interests_application_index
  ON rent_ops_application_interests(application_id, source_order, source_rank);
CREATE INDEX IF NOT EXISTS rent_ops_application_interests_prospect_index
  ON rent_ops_application_interests(prospect_id, source_order, source_rank);

CREATE TABLE IF NOT EXISTS rent_ops_application_participants (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  application_link_knowledge text,
  person_id varchar(160) REFERENCES rent_ops_people(id),
  person_link_knowledge text,
  source_order integer,
  role text,
  role_knowledge text NOT NULL,
  relationship text,
  relationship_knowledge text NOT NULL,
  is_minor boolean,
  minor_knowledge text NOT NULL,
  is_financially_responsible boolean,
  financial_responsibility_knowledge text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('source','manual','unknown')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_participants_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_participants_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_participants_application_link_check CHECK (application_id IS NULL OR application_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_participants_person_link_check CHECK (person_id IS NULL OR person_link_knowledge IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS rent_ops_application_participants_application_index
  ON rent_ops_application_participants(application_id, source_order);
CREATE INDEX IF NOT EXISTS rent_ops_application_participants_prospect_index
  ON rent_ops_application_participants(prospect_id, source_order);

CREATE TABLE IF NOT EXISTS rent_ops_application_requirement_occurrences (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  application_link_knowledge text,
  key text,
  label text,
  status text,
  status_knowledge text NOT NULL,
  requested_on date,
  requested_on_knowledge text NOT NULL,
  resolved_on date,
  resolved_on_knowledge text NOT NULL,
  document_id varchar(160),
  document_link_knowledge text,
  origin text NOT NULL CHECK (origin IN ('source','manual','unknown')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_requirements_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_requirements_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_requirements_application_link_check CHECK (application_id IS NULL OR application_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_requirements_document_link_check CHECK (document_id IS NULL OR document_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_requirements_status_check CHECK (status IS NULL OR status IN ('requested','received','waived','rejected'))
);

CREATE TABLE IF NOT EXISTS rent_ops_application_template_definitions (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  name text,
  name_knowledge text NOT NULL,
  active boolean,
  active_knowledge text NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_template_definitions_source_unique UNIQUE (source_system, source_id)
);

CREATE TABLE IF NOT EXISTS rent_ops_application_template_sections (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  template_id varchar(160) REFERENCES rent_ops_application_template_definitions(id),
  template_link_knowledge text,
  name text,
  name_knowledge text NOT NULL,
  source_order integer,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_template_sections_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_template_sections_template_link_check CHECK (
    (template_id IS NULL AND (template_link_knowledge IS NULL OR template_link_knowledge IN ('unknown','ambiguous')))
    OR (template_id IS NOT NULL AND template_link_knowledge IN ('exact','manual'))
  )
);

CREATE TABLE IF NOT EXISTS rent_ops_application_template_fields (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  template_id varchar(160) REFERENCES rent_ops_application_template_definitions(id),
  template_link_knowledge text,
  section_id varchar(160) REFERENCES rent_ops_application_template_sections(id),
  section_link_knowledge text,
  key text,
  label text,
  value_type text,
  sensitive boolean NOT NULL DEFAULT false,
  source_order integer,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_template_fields_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_template_fields_template_link_check CHECK (
    (template_id IS NULL AND (template_link_knowledge IS NULL OR template_link_knowledge IN ('unknown','ambiguous')))
    OR (template_id IS NOT NULL AND template_link_knowledge IN ('exact','manual'))
  ),
  CONSTRAINT rent_ops_application_template_fields_section_link_check CHECK (
    (section_id IS NULL AND (section_link_knowledge IS NULL OR section_link_knowledge IN ('unknown','ambiguous')))
    OR (section_id IS NOT NULL AND section_link_knowledge IN ('exact','manual'))
  ),
  CONSTRAINT rent_ops_application_template_fields_value_type_check CHECK (value_type IS NULL OR value_type IN ('text','integer','decimal','boolean','date','choice','multi_choice','money'))
);

CREATE TABLE IF NOT EXISTS rent_ops_application_answer_occurrences (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  application_link_knowledge text,
  field_id varchar(160) REFERENCES rent_ops_application_template_fields(id),
  field_link_knowledge text,
  value_type text NOT NULL CHECK (value_type IN ('text','integer','decimal','boolean','date','choice','multi_choice','money')),
  safe_value jsonb,
  value_knowledge text NOT NULL CHECK (value_knowledge IN ('known','unknown','ambiguous','restricted')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_answers_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_answers_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_answers_application_link_check CHECK (application_id IS NULL OR application_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_answers_field_link_check CHECK (field_id IS NULL OR field_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_answers_restricted_value_check CHECK (value_knowledge = 'known' OR safe_value IS NULL)
);

CREATE INDEX IF NOT EXISTS rent_ops_application_answers_application_index
  ON rent_ops_application_answer_occurrences(application_id);
CREATE INDEX IF NOT EXISTS rent_ops_application_answers_prospect_index
  ON rent_ops_application_answer_occurrences(prospect_id);

CREATE TABLE IF NOT EXISTS rent_ops_application_history_documents (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  application_link_knowledge text,
  type text,
  type_knowledge text NOT NULL,
  state text,
  state_knowledge text NOT NULL,
  file_name text,
  mime_type text,
  metadata_size_bytes integer,
  metadata_checksum_sha256 varchar(64),
  availability text NOT NULL CHECK (availability IN ('metadata','unavailable')),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_history_documents_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_history_documents_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_history_documents_application_link_check CHECK (application_id IS NULL OR application_link_knowledge IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS rent_ops_application_history_documents_application_index
  ON rent_ops_application_history_documents(application_id);
CREATE INDEX IF NOT EXISTS rent_ops_application_history_documents_prospect_index
  ON rent_ops_application_history_documents(prospect_id);

CREATE TABLE IF NOT EXISTS rent_ops_application_history_activities (
  id varchar(160) PRIMARY KEY,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  source_updated_at timestamptz,
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  prospect_link_knowledge text,
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  application_link_knowledge text,
  type text,
  occurred_at timestamptz,
  occurred_at_knowledge text NOT NULL,
  actor text,
  actor_knowledge text NOT NULL,
  summary text,
  summary_knowledge text NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  CONSTRAINT rent_ops_application_history_activities_source_unique UNIQUE (source_system, source_id),
  CONSTRAINT rent_ops_application_history_activities_prospect_link_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL),
  CONSTRAINT rent_ops_application_history_activities_application_link_check CHECK (application_id IS NULL OR application_link_knowledge IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS rent_ops_application_history_activities_application_index
  ON rent_ops_application_history_activities(application_id, occurred_at);
CREATE INDEX IF NOT EXISTS rent_ops_application_history_activities_prospect_index
  ON rent_ops_application_history_activities(prospect_id, occurred_at);

CREATE TABLE IF NOT EXISTS rent_ops_application_history_blockers (
  id varchar(160) PRIMARY KEY,
  code text NOT NULL CHECK (code IN ('application_answers_missing')),
  application_id varchar(160) REFERENCES rent_ops_application_history(id),
  prospect_id varchar(160) REFERENCES rent_ops_prospects(id),
  occurrence_count integer NOT NULL CHECK (occurrence_count >= 0),
  reason text NOT NULL CHECK (reason IN ('source_collection_missing','source_collection_empty','source_rows_unusable'))
  -- Blockers are aggregate diagnostics and may remain unlinked when a source
  -- collection has no resolvable application/prospect parent.
);

CREATE TABLE IF NOT EXISTS rent_ops_application_history_aggregates (
  id varchar(160) PRIMARY KEY,
  restricted_answer_count integer NOT NULL CHECK (restricted_answer_count >= 0),
  unmapped_answer_count integer NOT NULL CHECK (unmapped_answer_count >= 0),
  missing_answer_applications integer NOT NULL CHECK (missing_answer_applications >= 0),
  metadata_only_document_count integer NOT NULL CHECK (metadata_only_document_count >= 0),
  unavailable_document_count integer NOT NULL CHECK (unavailable_document_count >= 0),
  unlinked_activity_count integer NOT NULL CHECK (unlinked_activity_count >= 0),
  unlinked_interest_count integer NOT NULL CHECK (unlinked_interest_count >= 0),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0)
);

-- Historical links are additive to the existing metadata/activity tables.
-- `historical_application_id` avoids confusing a source application with a
-- current public-portal application that happens to share an identifier.
ALTER TABLE rent_ops_applications
  ADD COLUMN IF NOT EXISTS prospect_id varchar(160),
  ADD COLUMN IF NOT EXISTS prospect_link_knowledge text;
ALTER TABLE rent_ops_documents
  ADD COLUMN IF NOT EXISTS historical_application_id varchar(160),
  ADD COLUMN IF NOT EXISTS prospect_id varchar(160),
  ADD COLUMN IF NOT EXISTS historical_application_link_knowledge text,
  ADD COLUMN IF NOT EXISTS prospect_link_knowledge text;
ALTER TABLE rent_ops_activity_events
  ADD COLUMN IF NOT EXISTS historical_application_id varchar(160),
  ADD COLUMN IF NOT EXISTS prospect_id varchar(160),
  ADD COLUMN IF NOT EXISTS historical_application_link_knowledge text,
  ADD COLUMN IF NOT EXISTS prospect_link_knowledge text;

-- Existing v8 tables receive additive, NOT VALID links.  This preserves the
-- upgrade boundary for any pre-v9 rows while enforcing the link on every new
-- row; the independent audit below reports any legacy orphan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_applications_prospect_fk') THEN
    ALTER TABLE rent_ops_applications ADD CONSTRAINT rent_ops_applications_prospect_fk FOREIGN KEY (prospect_id) REFERENCES rent_ops_prospects(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_applications_prospect_link_knowledge_check') THEN
    ALTER TABLE rent_ops_applications ADD CONSTRAINT rent_ops_applications_prospect_link_knowledge_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_documents_historical_application_fk') THEN
    ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_historical_application_fk FOREIGN KEY (historical_application_id) REFERENCES rent_ops_application_history(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_documents_prospect_fk') THEN
    ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_prospect_fk FOREIGN KEY (prospect_id) REFERENCES rent_ops_prospects(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_documents_historical_application_link_knowledge_check') THEN
    ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_historical_application_link_knowledge_check CHECK (historical_application_id IS NULL OR historical_application_link_knowledge IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_documents_prospect_link_knowledge_check') THEN
    ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_prospect_link_knowledge_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_activity_historical_application_fk') THEN
    ALTER TABLE rent_ops_activity_events ADD CONSTRAINT rent_ops_activity_historical_application_fk FOREIGN KEY (historical_application_id) REFERENCES rent_ops_application_history(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_activity_prospect_fk') THEN
    ALTER TABLE rent_ops_activity_events ADD CONSTRAINT rent_ops_activity_prospect_fk FOREIGN KEY (prospect_id) REFERENCES rent_ops_prospects(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_activity_historical_application_link_knowledge_check') THEN
    ALTER TABLE rent_ops_activity_events ADD CONSTRAINT rent_ops_activity_historical_application_link_knowledge_check CHECK (historical_application_id IS NULL OR historical_application_link_knowledge IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_activity_prospect_link_knowledge_check') THEN
    ALTER TABLE rent_ops_activity_events ADD CONSTRAINT rent_ops_activity_prospect_link_knowledge_check CHECK (prospect_id IS NULL OR prospect_link_knowledge IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_application_requirements_document_fk') THEN
    ALTER TABLE rent_ops_application_requirement_occurrences ADD CONSTRAINT rent_ops_application_requirements_document_fk FOREIGN KEY (document_id) REFERENCES rent_ops_application_history_documents(id) NOT VALID;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS rent_ops_documents_historical_application_index
  ON rent_ops_documents(historical_application_id);
CREATE INDEX IF NOT EXISTS rent_ops_documents_prospect_index
  ON rent_ops_documents(prospect_id);
CREATE INDEX IF NOT EXISTS rent_ops_activity_historical_application_index
  ON rent_ops_activity_events(historical_application_id, occurred_at);
CREATE INDEX IF NOT EXISTS rent_ops_activity_prospect_index
  ON rent_ops_activity_events(prospect_id, occurred_at);

CREATE OR REPLACE FUNCTION rent_ops_guard_v9_application_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'rent_ops_v9_application_history_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS rent_ops_prospects_immutable_guard ON rent_ops_prospects;
CREATE TRIGGER rent_ops_prospects_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_prospects FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_history_immutable_guard ON rent_ops_application_history;
CREATE TRIGGER rent_ops_application_history_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_history FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_interests_immutable_guard ON rent_ops_application_interests;
CREATE TRIGGER rent_ops_application_interests_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_interests FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_participants_immutable_guard ON rent_ops_application_participants;
CREATE TRIGGER rent_ops_application_participants_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_participants FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_requirements_immutable_guard ON rent_ops_application_requirement_occurrences;
CREATE TRIGGER rent_ops_application_requirements_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_requirement_occurrences FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_templates_immutable_guard ON rent_ops_application_template_definitions;
CREATE TRIGGER rent_ops_application_templates_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_template_definitions FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_template_sections_immutable_guard ON rent_ops_application_template_sections;
CREATE TRIGGER rent_ops_application_template_sections_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_template_sections FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_template_fields_immutable_guard ON rent_ops_application_template_fields;
CREATE TRIGGER rent_ops_application_template_fields_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_template_fields FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_answers_immutable_guard ON rent_ops_application_answer_occurrences;
CREATE TRIGGER rent_ops_application_answers_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_answer_occurrences FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_history_documents_immutable_guard ON rent_ops_application_history_documents;
CREATE TRIGGER rent_ops_application_history_documents_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_history_documents FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_history_activities_immutable_guard ON rent_ops_application_history_activities;
CREATE TRIGGER rent_ops_application_history_activities_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_history_activities FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_history_blockers_immutable_guard ON rent_ops_application_history_blockers;
CREATE TRIGGER rent_ops_application_history_blockers_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_history_blockers FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();
DROP TRIGGER IF EXISTS rent_ops_application_history_aggregates_immutable_guard ON rent_ops_application_history_aggregates;
CREATE TRIGGER rent_ops_application_history_aggregates_immutable_guard BEFORE UPDATE OR DELETE ON rent_ops_application_history_aggregates FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v9_application_history_immutable();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (9, '__RENT_OPS_V9_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 5 AND checksum_sha256 = '__RENT_OPS_V5_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 6 AND checksum_sha256 = '__RENT_OPS_V6_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 7 AND checksum_sha256 = '__RENT_OPS_V7_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 8 AND checksum_sha256 = '__RENT_OPS_V8_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 9 AND checksum_sha256 = '__RENT_OPS_V9_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v9_post_insert_checksum_guard;
