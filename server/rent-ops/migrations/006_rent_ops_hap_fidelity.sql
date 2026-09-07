-- Rent Operations schema v6 is additive.  HAP contract children are promoted
-- into operational projections while the restricted archive remains separate.
-- Every nullable fact/link below is deliberate: an unresolved source row is
-- retained and blocks parity instead of being silently dropped or guessed.

-- v5 is immutable and must be present byte-for-byte before v6 is applied.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 5 AND checksum_sha256 = '__RENT_OPS_V5_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v5_checksum_guard;

CREATE TABLE IF NOT EXISTS rent_ops_subsidy_tenants (
  id varchar(160) PRIMARY KEY,
  source_system text,
  source_id text,
  subsidy_contract_id varchar(160) REFERENCES rent_ops_subsidy_contracts(id),
  subsidy_contract_link_knowledge text CHECK (subsidy_contract_link_knowledge IS NULL OR subsidy_contract_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  tenancy_id varchar(160) REFERENCES rent_ops_tenancies(id),
  tenancy_link_knowledge text CHECK (tenancy_link_knowledge IS NULL OR tenancy_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  person_id varchar(160) REFERENCES rent_ops_people(id),
  person_link_knowledge text CHECK (person_link_knowledge IS NULL OR person_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  property_link_knowledge text CHECK (property_link_knowledge IS NULL OR property_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  unit_id varchar(160) REFERENCES rent_ops_units(id),
  unit_link_knowledge text CHECK (unit_link_knowledge IS NULL OR unit_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  effective_from date,
  effective_from_knowledge text CHECK (effective_from_knowledge IS NULL OR effective_from_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  effective_to date,
  effective_to_knowledge text CHECK (effective_to_knowledge IS NULL OR effective_to_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  amount_knowledge text CHECK (amount_knowledge IS NULL OR amount_knowledge IN ('known', 'unknown')),
  payer text CHECK (payer IS NULL OR payer IN ('tenant', 'agency', 'owner', 'unknown')),
  payer_knowledge text CHECK (payer_knowledge IS NULL OR payer_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  status text CHECK (status IS NULL OR status IN ('active', 'ended', 'pending', 'exception')),
  status_knowledge text CHECK (status_knowledge IS NULL OR status_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  CONSTRAINT rent_ops_subsidy_tenants_date_order CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CONSTRAINT rent_ops_subsidy_tenants_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE TABLE IF NOT EXISTS rent_ops_subsidy_payments (
  id varchar(160) PRIMARY KEY,
  source_system text,
  source_id text,
  subsidy_contract_id varchar(160) REFERENCES rent_ops_subsidy_contracts(id),
  subsidy_contract_link_knowledge text CHECK (subsidy_contract_link_knowledge IS NULL OR subsidy_contract_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  subsidy_tenant_id varchar(160) REFERENCES rent_ops_subsidy_tenants(id),
  subsidy_tenant_link_knowledge text CHECK (subsidy_tenant_link_knowledge IS NULL OR subsidy_tenant_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  tenancy_id varchar(160) REFERENCES rent_ops_tenancies(id),
  tenancy_link_knowledge text CHECK (tenancy_link_knowledge IS NULL OR tenancy_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  person_id varchar(160) REFERENCES rent_ops_people(id),
  person_link_knowledge text CHECK (person_link_knowledge IS NULL OR person_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  property_id varchar(160) REFERENCES rent_ops_properties(id),
  property_link_knowledge text CHECK (property_link_knowledge IS NULL OR property_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  unit_id varchar(160) REFERENCES rent_ops_units(id),
  unit_link_knowledge text CHECK (unit_link_knowledge IS NULL OR unit_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  payment_transaction_id varchar(160) REFERENCES rent_ops_ledger_transactions(id),
  payment_link_knowledge text CHECK (payment_link_knowledge IS NULL OR payment_link_knowledge IN ('exact', 'unknown', 'ambiguous')),
  payment_on date,
  payment_on_knowledge text CHECK (payment_on_knowledge IS NULL OR payment_on_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  amount_knowledge text CHECK (amount_knowledge IS NULL OR amount_knowledge IN ('known', 'unknown')),
  payer text CHECK (payer IS NULL OR payer IN ('tenant', 'agency', 'owner', 'unknown')),
  payer_knowledge text CHECK (payer_knowledge IS NULL OR payer_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  status text CHECK (status IS NULL OR status IN ('received', 'pending', 'voided', 'reversed')),
  status_knowledge text CHECK (status_knowledge IS NULL OR status_knowledge IN ('source', 'unknown', 'ambiguous', 'inferred')),
  CONSTRAINT rent_ops_subsidy_payments_source_pair CHECK ((source_system IS NULL) = (source_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_subsidy_tenants_source_unique
  ON rent_ops_subsidy_tenants(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_subsidy_tenants_contract_index
  ON rent_ops_subsidy_tenants(subsidy_contract_id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_subsidy_payments_source_unique
  ON rent_ops_subsidy_payments(source_system, source_id);
CREATE INDEX IF NOT EXISTS rent_ops_subsidy_payments_contract_index
  ON rent_ops_subsidy_payments(subsidy_contract_id);
CREATE INDEX IF NOT EXISTS rent_ops_subsidy_payments_payment_index
  ON rent_ops_subsidy_payments(payment_transaction_id);

-- Preserve the ordered immutable checksum chain.  The conflict predicate is
-- intentionally strict: a prior applied checksum can never be overwritten.
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (1, '__RENT_OPS_V1_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (2, '__RENT_OPS_V2_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (3, '__RENT_OPS_V3_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (4, '__RENT_OPS_V4_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (5, '__RENT_OPS_V5_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (6, '__RENT_OPS_V6_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 5 AND checksum_sha256 = '__RENT_OPS_V5_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 6 AND checksum_sha256 = '__RENT_OPS_V6_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v6_post_insert_checksum_guard;
