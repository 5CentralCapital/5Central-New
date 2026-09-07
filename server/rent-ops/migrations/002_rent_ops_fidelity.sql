-- Rent Operations schema v2 is additive and transform-safe. It does not
-- rewrite v1 facts or synthesize missing dates/relationships. Existing v1
-- rows keep NULL v2 fidelity fields until a reviewed source transform fills
-- them; fresh staging imports populate every fidelity field directly.
-- The renderer fills both checksum tokens before an operator applies SQL.

CREATE TABLE IF NOT EXISTS rent_ops_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  down_sql_sha256 varchar(64) CHECK (down_sql_sha256 IS NULL OR down_sql_sha256 ~ '^[0-9a-f]{64}$')
);

-- Refuse an out-of-order or changed v1 before any v2 DDL runs. The v1 source
-- remains immutable; this is only an independent ordered-ledger guard.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_meta
  WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v1_checksum_guard;

ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS scope_type text;
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS scope_id varchar(160);
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS charge_definition_id text;
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS charge_definition_key text;
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS person_id varchar(160);
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS effective_from_knowledge text;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN tenancy_id DROP NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN unit_id DROP NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN effective_from DROP NOT NULL;

ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS received_on_knowledge text;
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS unit_link_knowledge text;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN tenancy_id DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN unit_id DROP NOT NULL;
ALTER TABLE rent_ops_security_deposits ALTER COLUMN received_on DROP NOT NULL;

-- v2 keeps the existing v1 foreign keys and adds the nullable person FK that
-- was not representable in the v1 schedule table. NOT VALID permits a
-- populated v1 database to be inspected and transformed before validation;
-- every newly inserted v2 row is still checked by PostgreSQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_person_fk') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_person_fk
      FOREIGN KEY (person_id) REFERENCES rent_ops_people(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_v2_required_fields') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_v2_required_fields
      CHECK (
        source_system IS NULL
        OR (scope_type IS NOT NULL AND scope_id IS NOT NULL AND (charge_definition_id IS NOT NULL OR charge_definition_key IS NOT NULL))
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_deposits_v2_required_knowledge') THEN
    ALTER TABLE rent_ops_security_deposits
      ADD CONSTRAINT rent_ops_deposits_v2_required_knowledge
      CHECK (
        source_system IS NULL
        OR (received_on_knowledge IS NOT NULL AND unit_link_knowledge IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

-- Constraints are nullable for untouched v1 rows and become strict for all
-- newly imported v2 rows. Every block is conditional so a rerun is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_scope_type_check') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_scope_type_check
      CHECK (scope_type IS NULL OR scope_type IN ('tenant', 'unit', 'property'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_scope_id_check') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_scope_id_check
      CHECK (scope_type IS NULL OR (scope_id IS NOT NULL AND length(trim(scope_id)) > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_scope_shape_check') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_scope_shape_check
      CHECK (
        scope_type IS NULL
        OR (scope_type = 'property' AND unit_id IS NULL AND person_id IS NULL AND tenancy_id IS NULL)
        OR (scope_type = 'unit' AND unit_id IS NOT NULL AND person_id IS NULL AND tenancy_id IS NULL)
        OR (scope_type = 'tenant' AND (person_id IS NOT NULL OR tenancy_id IS NOT NULL))
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_scope_person_check') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_scope_person_check
      CHECK (scope_type IS NULL OR scope_type <> 'tenant' OR person_id IS NOT NULL OR tenancy_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_definition_check') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_definition_check
      CHECK (scope_type IS NULL OR charge_definition_id IS NOT NULL OR charge_definition_key IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_schedules_effective_from_knowledge_check') THEN
    ALTER TABLE rent_ops_recurring_charge_schedules
      ADD CONSTRAINT rent_ops_schedules_effective_from_knowledge_check
      CHECK (effective_from_knowledge IS NULL OR (effective_from IS NOT NULL AND effective_from_knowledge = 'source') OR (effective_from IS NULL AND effective_from_knowledge = 'unknown_open_start'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_deposits_received_on_knowledge_check') THEN
    ALTER TABLE rent_ops_security_deposits
      ADD CONSTRAINT rent_ops_deposits_received_on_knowledge_check
      CHECK (received_on_knowledge IS NULL OR (received_on IS NOT NULL AND received_on_knowledge = 'source') OR (received_on IS NULL AND received_on_knowledge = 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_deposits_unit_link_knowledge_check') THEN
    ALTER TABLE rent_ops_security_deposits
      ADD CONSTRAINT rent_ops_deposits_unit_link_knowledge_check
      CHECK (
        unit_link_knowledge IS NULL
        OR (unit_id IS NOT NULL AND unit_link_knowledge = 'exact')
        OR (unit_id IS NULL AND unit_link_knowledge = 'unknown')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rent_ops_deposits_disposition_date_v2') THEN
    ALTER TABLE rent_ops_security_deposits DROP CONSTRAINT IF EXISTS rent_ops_deposits_disposition_date;
    ALTER TABLE rent_ops_security_deposits
      ADD CONSTRAINT rent_ops_deposits_disposition_date_v2
      CHECK (
        (disposition_status = 'held' AND disposed_on IS NULL)
        OR (disposition_status <> 'held' AND disposed_on IS NOT NULL AND (received_on IS NULL OR disposed_on >= received_on))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rent_ops_schedules_scope_definition_index
  ON rent_ops_recurring_charge_schedules(scope_type, scope_id, charge_definition_key, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS rent_ops_schedules_property_index
  ON rent_ops_recurring_charge_schedules(property_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS rent_ops_deposits_person_unit_index
  ON rent_ops_security_deposits(person_id, unit_id, received_on);
CREATE INDEX IF NOT EXISTS rent_ops_deposits_tenancy_index
  ON rent_ops_security_deposits(tenancy_id, received_on);

-- Record v1 exactly as applied, then append v2. ON CONFLICT is deliberately
-- conditional: a changed checksum never silently overwrites an applied row.
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (1, '__RENT_OPS_V1_CHECKSUM__')
ON CONFLICT (version) DO UPDATE
SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__'
) THEN 1 ELSE 0 END AS rent_ops_v1_order_guard;

INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (2, '__RENT_OPS_V2_CHECKSUM__')
ON CONFLICT (version) DO UPDATE
SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;

-- A successful v2 apply must be visible in the ordered ledger with the exact
-- source checksum. This guard runs after the insert, so a partial/changed
-- ledger cannot be mistaken for an applied migration.
SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (
  SELECT 1 FROM rent_ops_schema_migrations
  WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__'
  )
) THEN 1 ELSE 0 END AS rent_ops_v2_post_insert_checksum_guard;
