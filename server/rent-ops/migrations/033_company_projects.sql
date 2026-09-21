-- Additive project operations. No QBO posting or live data initialization.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 32 AND checksum_sha256 = '__RENT_OPS_V32_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_projects_predecessor_guard;

ALTER TABLE rent_ops_units ADD CONSTRAINT company_units_property_identity UNIQUE (property_id, id);

CREATE TABLE company_projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160) REFERENCES rent_ops_units(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  project_type text NOT NULL DEFAULT 'rehab' CHECK (project_type IN ('flip','unit_turn','rehab','common_area','stabilization','administrative')),
  status text NOT NULL CHECK (status IN ('planning','active','on_hold','completed','archived')),
  start_on date,
  target_on date,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES company_legal_entities(organization_id, id),
  CHECK (target_on IS NULL OR start_on IS NULL OR target_on >= start_on),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, currency),
  FOREIGN KEY (property_id, unit_id) REFERENCES rent_ops_units(property_id, id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX company_projects_scope_updated
  ON company_projects (organization_id, legal_entity_id, property_id, updated_at DESC, id DESC);
CREATE INDEX company_projects_scope_status
  ON company_projects (organization_id, legal_entity_id, property_id, status, updated_at DESC, id DESC);

CREATE TABLE company_project_scope_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  category text,
  unit_label text,
  quantity numeric(24,12) NOT NULL CHECK (quantity >= 0),
  rate_cents bigint NOT NULL CHECK (rate_cents >= 0),
  estimated_cents bigint NOT NULL CHECK (estimated_cents >= 0),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id)
);
CREATE INDEX company_project_scope_items_project
  ON company_project_scope_items (organization_id, project_id, archived_at, id);

CREATE TABLE company_project_budget_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL CHECK (status IN ('draft','approved','superseded')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_estimated_cents bigint NOT NULL CHECK (total_estimated_cents >= 0),
  notes text,
  created_by varchar(160) NOT NULL CHECK (length(btrim(created_by)) > 0),
  approved_by varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  CHECK ((status IN ('approved','superseded') AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
    OR (status = 'draft' AND approved_at IS NULL AND approved_by IS NULL)),
  UNIQUE (organization_id, project_id, version_no),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX company_project_one_approved_budget
  ON company_project_budget_versions (organization_id, project_id)
  WHERE status = 'approved';

CREATE TABLE company_project_budget_lines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  budget_version_id uuid NOT NULL,
  scope_item_id uuid,
  position integer NOT NULL CHECK (position >= 0),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  unit_label text,
  quantity numeric(24,12) NOT NULL CHECK (quantity >= 0),
  rate_cents bigint NOT NULL CHECK (rate_cents >= 0),
  estimated_cents bigint NOT NULL CHECK (estimated_cents >= 0),
  FOREIGN KEY (organization_id, budget_version_id)
    REFERENCES company_project_budget_versions(organization_id, id),
  FOREIGN KEY (organization_id, scope_item_id)
    REFERENCES company_project_scope_items(organization_id, id),
  UNIQUE (organization_id, budget_version_id, position)
);
CREATE INDEX company_project_budget_lines_version
  ON company_project_budget_lines (organization_id, budget_version_id, position);

CREATE TABLE company_project_tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text,
  status text NOT NULL CHECK (status IN ('not_started','in_progress','blocked','completed','cancelled')),
  starts_on date,
  due_on date,
  completed_on date,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  CHECK (due_on IS NULL OR starts_on IS NULL OR due_on >= starts_on),
  CHECK (status <> 'completed' OR completed_on IS NOT NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id)
);
CREATE INDEX company_project_tasks_project
  ON company_project_tasks (organization_id, project_id, archived_at, starts_on, due_on, id);

CREATE TABLE company_project_task_dependencies (
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, task_id) REFERENCES company_project_tasks(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, depends_on_task_id) REFERENCES company_project_tasks(organization_id, project_id, id)
);
CREATE INDEX company_project_task_dependencies_source
  ON company_project_task_dependencies (organization_id, project_id, task_id);
CREATE INDEX company_project_task_dependencies_target
  ON company_project_task_dependencies (organization_id, project_id, depends_on_task_id);

CREATE TABLE company_project_draft_costs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  scope_item_id uuid,
  vendor_name text,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  incurred_on date NOT NULL,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, scope_item_id)
    REFERENCES company_project_scope_items(organization_id, project_id, id)
);
CREATE INDEX company_project_draft_costs_project
  ON company_project_draft_costs (organization_id, project_id, archived_at, incurred_on, id);

CREATE TABLE company_project_posted_actuals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  scope_item_id uuid,
  provider text NOT NULL CHECK (provider = 'qbo'),
  source_scope text NOT NULL CHECK (length(btrim(source_scope)) BETWEEN 1 AND 200),
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  amount_cents bigint NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  posted_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES company_projects(organization_id, id),
  UNIQUE (organization_id, provider, source_scope, external_id),
  FOREIGN KEY (organization_id, project_id, scope_item_id)
    REFERENCES company_project_scope_items(organization_id, project_id, id)
);
CREATE INDEX company_project_posted_actuals_project
  ON company_project_posted_actuals (organization_id, project_id, posted_on, id);

-- Exact cents may only be aggregated within their immutable project currency.
ALTER TABLE company_project_budget_versions ADD CONSTRAINT company_budget_currency_matches_project
  FOREIGN KEY (organization_id, project_id, currency) REFERENCES company_projects(organization_id, id, currency);
ALTER TABLE company_project_draft_costs ADD CONSTRAINT company_draft_currency_matches_project
  FOREIGN KEY (organization_id, project_id, currency) REFERENCES company_projects(organization_id, id, currency);
ALTER TABLE company_project_posted_actuals ADD CONSTRAINT company_actual_currency_matches_project
  FOREIGN KEY (organization_id, project_id, currency) REFERENCES company_projects(organization_id, id, currency);

-- Source identities and saved snapshots cannot be rewritten by normal writers.
CREATE FUNCTION company_guard_budget_line_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM company_project_budget_versions
    WHERE organization_id = NEW.organization_id AND id = NEW.budget_version_id AND status = 'draft'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company_approved_budget_lines_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.scope_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM company_project_scope_items i
    JOIN company_project_budget_versions b ON b.organization_id = i.organization_id AND b.project_id = i.project_id
    WHERE i.id = NEW.scope_item_id AND i.organization_id = NEW.organization_id AND b.id = NEW.budget_version_id
  ) THEN
    RAISE EXCEPTION 'company_budget_line_project_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_project_budget_line_scope BEFORE INSERT OR UPDATE ON company_project_budget_lines
FOR EACH ROW EXECUTE FUNCTION company_guard_budget_line_scope();

CREATE FUNCTION company_guard_project_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_project_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR to_jsonb(NEW)->'project_id' IS DISTINCT FROM to_jsonb(OLD)->'project_id'
    OR to_jsonb(NEW)->'legal_entity_id' IS DISTINCT FROM to_jsonb(OLD)->'legal_entity_id'
    OR to_jsonb(NEW)->'property_id' IS DISTINCT FROM to_jsonb(OLD)->'property_id'
    OR to_jsonb(NEW)->'currency' IS DISTINCT FROM to_jsonb(OLD)->'currency'
    OR TG_TABLE_NAME IN ('company_project_budget_lines','company_project_posted_actuals') THEN
    RAISE EXCEPTION 'company_project_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_project_budget_versions' AND to_jsonb(OLD)->>'status' <> 'draft' AND (
    NOT (to_jsonb(OLD)->>'status' = 'approved' AND to_jsonb(NEW)->>'status' = 'superseded')
    OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
  ) THEN
    RAISE EXCEPTION 'company_approved_budget_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_projects_identity BEFORE UPDATE OR DELETE ON company_projects
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();
CREATE TRIGGER company_project_scope_items_identity BEFORE UPDATE OR DELETE ON company_project_scope_items
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();
CREATE TRIGGER company_project_budget_versions_identity BEFORE UPDATE OR DELETE ON company_project_budget_versions
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();
CREATE TRIGGER company_project_budget_lines_identity BEFORE UPDATE OR DELETE ON company_project_budget_lines
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();
CREATE TRIGGER company_project_tasks_identity BEFORE UPDATE OR DELETE ON company_project_tasks
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();
CREATE TRIGGER company_project_draft_costs_identity BEFORE UPDATE OR DELETE ON company_project_draft_costs
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();
CREATE TRIGGER company_project_posted_actuals_identity BEFORE UPDATE OR DELETE ON company_project_posted_actuals
FOR EACH ROW EXECUTE FUNCTION company_guard_project_identity();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (33, '__RENT_OPS_V33_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 33 AND checksum_sha256 = '__RENT_OPS_V33_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_projects_checksum_guard;
