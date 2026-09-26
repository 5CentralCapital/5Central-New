-- Whole-deal costs and funding are operational records, never a QuickBooks posting.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 52 AND checksum_sha256 = '__RENT_OPS_V52_CHECKSUM__'
) THEN 1 ELSE 0 END AS project_deal_ledger_predecessor_guard;

CREATE TABLE company_project_deal_ledger (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('cost','funding','sale_forecast')),
  lane text CHECK (lane IS NULL OR lane IN ('acquisition','rehab','financing','holding','selling','unallocated')),
  funding_kind text CHECK (funding_kind IS NULL OR funding_kind IN ('deposit','loan_principal','reserve','contribution','intercompany','sale_proceeds','settlement_clearing')),
  description text NOT NULL,
  vendor_name text,
  budget_cents bigint,
  amount_cents bigint,
  forecast_cents bigint,
  paid_cents bigint,
  incurred_on date,
  paid_on date,
  prepaid boolean NOT NULL DEFAULT false,
  funded_on date,
  gross_proceeds_cents bigint,
  sale_on date,
  source_kind text NOT NULL CHECK (source_kind IN ('qbo','operational','manual','estimate')),
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('unreconciled','source_backed','qbo_verified','void')),
  source_record_ref varchar(160),
  source_reference_hash varchar(64),
  source_provider text,
  source_legal_entity_id uuid,
  source_environment text,
  source_realm_id varchar(32),
  source_object_type varchar(120),
  source_object_id varchar(200),
  source_line_id varchar(200),
  source_version varchar(120),
  settlement_proof jsonb,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (organization_id, source_legal_entity_id) REFERENCES company_legal_entities(organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES company_projects(organization_id, id),
  CHECK ((entry_kind = 'cost' AND lane IS NOT NULL AND funding_kind IS NULL AND funded_on IS NULL AND gross_proceeds_cents IS NULL)
      OR (entry_kind = 'funding' AND lane IS NULL AND funding_kind IS NOT NULL AND amount_cents IS NOT NULL AND funded_on IS NOT NULL)
      OR (entry_kind = 'sale_forecast' AND lane IS NULL AND funding_kind IS NULL AND gross_proceeds_cents IS NOT NULL AND source_kind = 'estimate')),
  CHECK (budget_cents IS NULL OR budget_cents >= 0),
  CHECK (forecast_cents IS NULL OR forecast_cents >= 0),
  CHECK (paid_cents IS NULL OR paid_cents >= 0),
  CHECK (entry_kind <> 'cost' OR budget_cents IS NOT NULL OR amount_cents IS NOT NULL OR forecast_cents IS NOT NULL),
  CHECK (paid_cents IS NULL OR paid_on IS NOT NULL),
  CHECK (source_kind <> 'qbo' OR (source_provider = 'qbo' AND source_legal_entity_id IS NOT NULL AND source_environment IN ('production','sandbox') AND source_realm_id IS NOT NULL AND source_object_type IS NOT NULL AND source_object_id IS NOT NULL AND source_version IS NOT NULL)),
  CHECK (reconciliation_state <> 'qbo_verified' OR source_kind = 'qbo'),
  CHECK (gross_proceeds_cents IS NULL OR gross_proceeds_cents >= 0),
  CHECK (paid_cents IS NULL OR paid_cents = 0 OR settlement_proof IS NOT NULL),
  CHECK (settlement_proof IS NULL OR jsonb_typeof(settlement_proof) = 'object'),
  CHECK (source_reference_hash IS NULL OR source_reference_hash ~ '^[a-f0-9]{64}$'),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX company_project_deal_ledger_qbo_source
  ON company_project_deal_ledger (organization_id, source_legal_entity_id, source_provider, source_environment, source_realm_id, source_object_type, source_object_id, COALESCE(source_line_id, ''))
  WHERE source_provider IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX company_project_deal_ledger_active_sale_forecast
  ON company_project_deal_ledger (organization_id, project_id)
  WHERE entry_kind = 'sale_forecast' AND archived_at IS NULL;
CREATE INDEX company_project_deal_ledger_project
  ON company_project_deal_ledger (organization_id, project_id, entry_kind, lane, archived_at, updated_at DESC, id DESC);

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (53, '__RENT_OPS_V53_CHECKSUM__')
ON CONFLICT(version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations WHERE version = 53 AND checksum_sha256 = '__RENT_OPS_V53_CHECKSUM__'
) THEN 1 ELSE 0 END AS project_deal_ledger_checksum_guard;
