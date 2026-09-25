-- Planning associations do not establish property ownership or legal posting scope.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 51 AND checksum_sha256 = '__RENT_OPS_V51_CHECKSUM__'
) THEN 1 ELSE 0 END AS project_property_plan_predecessor_guard;

CREATE TABLE company_project_property_plans (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES company_organizations(id),
  legal_entity_id uuid NOT NULL,
  property_id varchar(160) NOT NULL REFERENCES rent_ops_properties(id),
  assignment_start_on date NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','converted','cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  FOREIGN KEY (organization_id, legal_entity_id) REFERENCES company_legal_entities(organization_id, id)
);
CREATE UNIQUE INDEX company_project_property_plan_active
  ON company_project_property_plans(organization_id, legal_entity_id, property_id)
  WHERE status='planned';
CREATE INDEX company_project_property_plan_scope
  ON company_project_property_plans(organization_id, legal_entity_id, assignment_start_on);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (52, '__RENT_OPS_V52_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 52 AND checksum_sha256 = '__RENT_OPS_V52_CHECKSUM__'
) THEN 1 ELSE 0 END AS project_property_plan_checksum_guard;
