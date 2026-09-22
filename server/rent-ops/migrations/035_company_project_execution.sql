-- Project assignments, commitments, inspections, draws and financial source links.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 34 AND checksum_sha256 = '__RENT_OPS_V34_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_project_execution_predecessor_guard;

CREATE TABLE company_project_templates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  project_type text NOT NULL CHECK (length(btrim(project_type)) BETWEEN 1 AND 80),
  description text,
  currency varchar(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  created_by varchar(160) NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_project_templates_scope ON company_project_templates (organization_id, active, updated_at DESC, id DESC);

CREATE TABLE company_project_template_scope_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  template_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  category text,
  unit_label text,
  quantity numeric(24,12) NOT NULL CHECK (quantity >= 0),
  rate_cents bigint NOT NULL CHECK (rate_cents >= 0),
  position integer NOT NULL CHECK (position >= 0),
  FOREIGN KEY (organization_id, template_id) REFERENCES company_project_templates(organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, template_id, position)
);
CREATE INDEX company_project_template_scope_items_template ON company_project_template_scope_items (organization_id, template_id, position);

CREATE TABLE company_project_template_tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  template_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text,
  relative_days integer NOT NULL CHECK (relative_days >= 0),
  position integer NOT NULL CHECK (position >= 0),
  FOREIGN KEY (organization_id, template_id) REFERENCES company_project_templates(organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, template_id, position)
);
CREATE INDEX company_project_template_tasks_template ON company_project_template_tasks (organization_id, template_id, position);

CREATE TABLE company_project_assignments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  assignee_type text NOT NULL CHECK (assignee_type IN ('employee','vendor','person','team')),
  assignee_ref varchar(160) NOT NULL CHECK (length(btrim(assignee_ref)) > 0),
  role text NOT NULL CHECK (length(btrim(role)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','accepted','in_progress','complete','declined','cancelled')),
  starts_on date,
  due_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  CHECK (due_on IS NULL OR starts_on IS NULL OR due_on >= starts_on),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_project_assignments_project ON company_project_assignments (organization_id, project_id, status, due_on, id);

CREATE TABLE company_project_milestones (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','complete','blocked','cancelled')),
  target_on date,
  completed_on date,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  CHECK (status <> 'complete' OR completed_on IS NOT NULL),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_project_milestones_project ON company_project_milestones (organization_id, project_id, position, target_on, id);

CREATE TABLE company_project_inspections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  inspection_type text NOT NULL CHECK (length(btrim(inspection_type)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','passed','failed','conditional','cancelled')),
  scheduled_on date,
  inspected_on date,
  inspector_ref varchar(160),
  notes text,
  document_ref varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  UNIQUE (organization_id, id),
  CHECK (status IN ('scheduled','cancelled') OR inspected_on IS NOT NULL)
);
CREATE INDEX company_project_inspections_project ON company_project_inspections (organization_id, project_id, scheduled_on, id);

CREATE TABLE company_project_punch_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  inspection_id uuid,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  location text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','ready_for_review','complete','waived')),
  assigned_to varchar(160),
  due_on date,
  completed_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, inspection_id) REFERENCES company_project_inspections(organization_id, id),
  CHECK (status NOT IN ('complete','waived') OR completed_on IS NOT NULL),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_project_punch_items_project ON company_project_punch_items (organization_id, project_id, status, due_on, id);

CREATE TABLE company_project_vendors (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','on_hold')),
  contact_ref varchar(160),
  license_ref varchar(200),
  insurance_expires_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_project_vendors_scope ON company_project_vendors (organization_id, status, name, id);

CREATE TABLE company_project_bids (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  scope_item_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','shortlisted','accepted','rejected','withdrawn')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  submitted_on date,
  valid_until date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, vendor_id) REFERENCES company_project_vendors(organization_id, id),
  FOREIGN KEY (organization_id, project_id, scope_item_id) REFERENCES company_project_scope_items(organization_id, project_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  CHECK (valid_until IS NULL OR submitted_on IS NULL OR valid_until >= submitted_on)
);
CREATE INDEX company_project_bids_project ON company_project_bids (organization_id, project_id, status, updated_at DESC, id DESC);

CREATE TABLE company_project_commitments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  vendor_id uuid,
  bid_id uuid,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','closed','void')),
  original_cents bigint NOT NULL CHECK (original_cents >= 0),
  approved_change_cents bigint NOT NULL DEFAULT 0,
  committed_cents bigint NOT NULL CHECK (committed_cents >= 0 AND committed_cents = original_cents + approved_change_cents),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  start_on date,
  target_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, vendor_id) REFERENCES company_project_vendors(organization_id, id),
  FOREIGN KEY (organization_id, project_id, bid_id) REFERENCES company_project_bids(organization_id, project_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  CHECK (target_on IS NULL OR start_on IS NULL OR target_on >= start_on)
);
CREATE INDEX company_project_commitments_project ON company_project_commitments (organization_id, project_id, status, target_on, id);

CREATE TABLE company_project_change_orders (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  commitment_id uuid,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','void')),
  amount_cents bigint NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  included_in_budget_version_id uuid,
  submitted_on date,
  approved_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, commitment_id) REFERENCES company_project_commitments(organization_id, project_id, id),
  FOREIGN KEY (organization_id, included_in_budget_version_id) REFERENCES company_project_budget_versions(organization_id, id),
  UNIQUE (organization_id, id),
  CHECK (status <> 'approved' OR approved_on IS NOT NULL)
);
CREATE INDEX company_project_change_orders_project ON company_project_change_orders (organization_id, project_id, status, approved_on, id);

CREATE TABLE company_project_purchase_orders (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  commitment_id uuid NOT NULL,
  po_number varchar(80) NOT NULL CHECK (length(btrim(po_number)) > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_received','received','cancelled')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  issued_on date,
  received_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, commitment_id) REFERENCES company_project_commitments(organization_id, project_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, po_number),
  CHECK (status IN ('draft','cancelled') OR issued_on IS NOT NULL),
  CHECK (status NOT IN ('received') OR received_on IS NOT NULL)
);
CREATE INDEX company_project_purchase_orders_project ON company_project_purchase_orders (organization_id, project_id, status, issued_on, id);

CREATE TABLE company_project_draw_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  request_no integer NOT NULL CHECK (request_no > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','paid','rejected','void')),
  period_from date NOT NULL,
  period_to date NOT NULL,
  gross_eligible_cents bigint NOT NULL CHECK (gross_eligible_cents >= 0),
  retainage_percent numeric(8,5) NOT NULL CHECK (retainage_percent >= 0 AND retainage_percent <= 100),
  retainage_cents bigint NOT NULL CHECK (retainage_cents >= 0 AND retainage_cents <= gross_eligible_cents),
  net_requested_cents bigint NOT NULL CHECK (net_requested_cents = gross_eligible_cents - retainage_cents AND net_requested_cents >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  submitted_on date,
  approved_on date,
  paid_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, request_no),
  CHECK (period_to >= period_from),
  CHECK (status IN ('draft','rejected','void') OR submitted_on IS NOT NULL),
  CHECK (status NOT IN ('approved','paid') OR approved_on IS NOT NULL),
  CHECK (status <> 'paid' OR paid_on IS NOT NULL)
);
CREATE INDEX company_project_draw_requests_project ON company_project_draw_requests (organization_id, project_id, status, period_to, request_no);

CREATE TABLE company_project_draw_request_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  draw_request_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('commitment','actual','change_order')),
  source_id uuid NOT NULL,
  eligible_cents bigint NOT NULL CHECK (eligible_cents >= 0),
  requested_cents bigint NOT NULL CHECK (requested_cents >= 0 AND requested_cents <= eligible_cents),
  retainage_eligible boolean NOT NULL DEFAULT true,
  retainage_cents bigint NOT NULL DEFAULT 0 CHECK (retainage_cents >= 0 AND retainage_cents <= requested_cents),
  notes text,
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, draw_request_id) REFERENCES company_project_draw_requests(organization_id, project_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, draw_request_id, source_type, source_id),
  CHECK (retainage_eligible OR retainage_cents = 0)
);
CREATE INDEX company_project_draw_request_items_request ON company_project_draw_request_items (organization_id, project_id, draw_request_id, source_type, source_id);

-- This table is a source-identity binding only. Amounts remain in the
-- verified finance read service so a stale local snapshot cannot masquerade
-- as current QBO actuals. It also gives the project domain a durable place to
-- associate an actual source with a commitment or scope line.
CREATE TABLE company_project_finance_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  project_id uuid NOT NULL,
  commitment_id uuid,
  scope_item_id uuid,
  provider text NOT NULL CHECK (provider = 'qbo'),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  realm_id varchar(32) NOT NULL CHECK (realm_id ~ '^[0-9]{1,32}$'),
  object_type varchar(120) NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9_]{0,119}$'),
  object_id varchar(200) NOT NULL CHECK (length(btrim(object_id)) BETWEEN 1 AND 200),
  line_id varchar(200),
  source_version varchar(120) NOT NULL CHECK (length(btrim(source_version)) BETWEEN 1 AND 120),
  allocated_cents bigint NOT NULL CHECK (allocated_cents >= 0),
  eligible boolean NOT NULL DEFAULT false,
  binding_status text NOT NULL DEFAULT 'unverified' CHECK (binding_status IN ('unverified','verified','unlinked','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, commitment_id) REFERENCES company_project_commitments(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, scope_item_id) REFERENCES company_project_scope_items(organization_id, project_id, id),
  UNIQUE (organization_id, provider, environment, realm_id, object_type, object_id, line_id, source_version),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_project_finance_bindings_project ON company_project_finance_bindings (organization_id, project_id, binding_status, object_type, object_id);

CREATE FUNCTION company_guard_project_execution_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_project_execution_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR to_jsonb(NEW)->'project_id' IS DISTINCT FROM to_jsonb(OLD)->'project_id'
    OR TG_TABLE_NAME = 'company_project_finance_bindings' AND (
      to_jsonb(NEW)->'provider' IS DISTINCT FROM to_jsonb(OLD)->'provider'
      OR to_jsonb(NEW)->'environment' IS DISTINCT FROM to_jsonb(OLD)->'environment'
      OR to_jsonb(NEW)->'realm_id' IS DISTINCT FROM to_jsonb(OLD)->'realm_id'
      OR to_jsonb(NEW)->'object_type' IS DISTINCT FROM to_jsonb(OLD)->'object_type'
      OR to_jsonb(NEW)->'object_id' IS DISTINCT FROM to_jsonb(OLD)->'object_id'
      OR to_jsonb(NEW)->'line_id' IS DISTINCT FROM to_jsonb(OLD)->'line_id'
      OR to_jsonb(NEW)->'source_version' IS DISTINCT FROM to_jsonb(OLD)->'source_version'
    ) THEN
    RAISE EXCEPTION 'company_project_execution_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_project_templates_identity BEFORE UPDATE OR DELETE ON company_project_templates FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_template_scope_items_identity BEFORE UPDATE OR DELETE ON company_project_template_scope_items FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_template_tasks_identity BEFORE UPDATE OR DELETE ON company_project_template_tasks FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_assignments_identity BEFORE UPDATE OR DELETE ON company_project_assignments FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_milestones_identity BEFORE UPDATE OR DELETE ON company_project_milestones FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_inspections_identity BEFORE UPDATE OR DELETE ON company_project_inspections FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_punch_items_identity BEFORE UPDATE OR DELETE ON company_project_punch_items FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_vendors_identity BEFORE UPDATE OR DELETE ON company_project_vendors FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_bids_identity BEFORE UPDATE OR DELETE ON company_project_bids FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_commitments_identity BEFORE UPDATE OR DELETE ON company_project_commitments FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_change_orders_identity BEFORE UPDATE OR DELETE ON company_project_change_orders FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_purchase_orders_identity BEFORE UPDATE OR DELETE ON company_project_purchase_orders FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_draw_requests_identity BEFORE UPDATE OR DELETE ON company_project_draw_requests FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_draw_request_items_identity BEFORE UPDATE OR DELETE ON company_project_draw_request_items FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();
CREATE TRIGGER company_project_finance_bindings_identity BEFORE UPDATE OR DELETE ON company_project_finance_bindings FOR EACH ROW EXECUTE FUNCTION company_guard_project_execution_identity();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (35, '__RENT_OPS_V35_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 35 AND checksum_sha256 = '__RENT_OPS_V35_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_project_execution_checksum_guard;
