-- Additive work orders, maintenance scheduling and chargeback intent.
-- No ledger posting, vendor billing or live data initialization.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 39 AND checksum_sha256 = '__RENT_OPS_V39_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_work_orders_predecessor_guard;

CREATE TABLE company_work_orders (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  unit_id varchar(160),
  tenancy_id varchar(160) REFERENCES rent_ops_tenancies(id),
  person_id varchar(160) REFERENCES rent_ops_people(id),
  project_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  category text NOT NULL CHECK (category IN ('plumbing','electrical','hvac','appliance','general','turnover','pest','exterior','other')),
  priority text NOT NULL CHECK (priority IN ('emergency','high','normal','low')),
  status text NOT NULL CHECK (status IN ('new','scheduled','in_progress','on_hold','completed','canceled')),
  reported_on date NOT NULL,
  scheduled_on date,
  completed_on date,
  assigned_to text CHECK (assigned_to IS NULL OR length(btrim(assigned_to)) BETWEEN 1 AND 200),
  entry_permitted boolean NOT NULL DEFAULT false,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  estimated_cost_cents bigint CHECK (estimated_cost_cents IS NULL OR estimated_cost_cents >= 0),
  -- A chargeback is only the intent to bill the tenant. A posted tenant charge
  -- is a separate ledger fact; linking it never creates or changes that charge.
  chargeback_amount_cents bigint CHECK (chargeback_amount_cents IS NULL OR chargeback_amount_cents > 0),
  chargeback_description text CHECK (chargeback_description IS NULL OR length(btrim(chargeback_description)) BETWEEN 1 AND 300),
  chargeback_ledger_transaction_id varchar(160) REFERENCES rent_ops_ledger_transactions(id),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_by varchar(160) NOT NULL CHECK (length(btrim(created_by)) > 0),
  updated_by varchar(160) NOT NULL CHECK (length(btrim(updated_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (property_id, unit_id) REFERENCES rent_ops_units(property_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  CHECK ((status = 'completed') = (completed_on IS NOT NULL)),
  CHECK (status <> 'scheduled' OR scheduled_on IS NOT NULL),
  CHECK (completed_on IS NULL OR completed_on >= reported_on),
  CHECK ((chargeback_amount_cents IS NULL) = (chargeback_description IS NULL)),
  CHECK (chargeback_ledger_transaction_id IS NULL OR chargeback_amount_cents IS NOT NULL),
  UNIQUE (organization_id, id)
);
CREATE INDEX company_work_orders_scope_status
  ON company_work_orders (organization_id, legal_entity_id, property_id, status, reported_on DESC, id DESC);
CREATE INDEX company_work_orders_unit
  ON company_work_orders (organization_id, property_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX company_work_orders_project
  ON company_work_orders (organization_id, project_id) WHERE project_id IS NOT NULL;
-- One posted tenant charge can satisfy at most one chargeback intent.
CREATE UNIQUE INDEX company_work_orders_chargeback_ledger
  ON company_work_orders (chargeback_ledger_transaction_id) WHERE chargeback_ledger_transaction_id IS NOT NULL;

-- Append-only status and activity history.
CREATE TABLE company_work_order_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  work_order_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created','updated','status_changed','note','project_linked','project_unlinked','chargeback_set','chargeback_cleared')),
  from_status text CHECK (from_status IS NULL OR from_status IN ('new','scheduled','in_progress','on_hold','completed','canceled')),
  to_status text CHECK (to_status IS NULL OR to_status IN ('new','scheduled','in_progress','on_hold','completed','canceled')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 4000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  record_revision integer NOT NULL CHECK (record_revision > 0),
  actor_id varchar(160) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, work_order_id) REFERENCES company_work_orders(organization_id, id),
  CHECK ((event_type = 'status_changed') = (from_status IS NOT NULL AND to_status IS NOT NULL)),
  CHECK (event_type <> 'note' OR note IS NOT NULL)
);
CREATE INDEX company_work_order_events_order
  ON company_work_order_events (organization_id, work_order_id, created_at, id);

CREATE FUNCTION company_guard_work_order_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_work_order_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'company_work_order_events' THEN
    RAISE EXCEPTION 'company_work_order_history_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'company_work_order_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_work_orders_identity BEFORE UPDATE OR DELETE ON company_work_orders
FOR EACH ROW EXECUTE FUNCTION company_guard_work_order_identity();
CREATE TRIGGER company_work_order_events_identity BEFORE UPDATE OR DELETE ON company_work_order_events
FOR EACH ROW EXECUTE FUNCTION company_guard_work_order_identity();

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (40, '__RENT_OPS_V40_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 40 AND checksum_sha256 = '__RENT_OPS_V40_CHECKSUM__'
) THEN 1 ELSE 0 END AS company_work_orders_checksum_guard;
