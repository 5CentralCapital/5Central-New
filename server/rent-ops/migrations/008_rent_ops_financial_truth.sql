-- Rent Operations v8: artifact-bound financial semantics and immutable
-- recurring schedule lineage.  This migration is additive and never rewrites
-- migrations 001-007 or source payloads.

CREATE TABLE IF NOT EXISTS rent_ops_charge_definitions (
  id varchar(160) PRIMARY KEY,
  source_system text,
  source_id text,
  source_artifact_sha256 varchar(64),
  artifact_observation_on date,
  display_name text,
  display_name_knowledge text,
  category text,
  category_knowledge text,
  active boolean,
  active_knowledge text,
  record_revision integer NOT NULL DEFAULT 1 CHECK (record_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_charge_definitions_category_check CHECK (category IS NULL OR category IN ('base_rent','recurring_fee','one_time_fee','subsidy','security_deposit','refundable_pet_deposit','move_in_funds','unapplied_cash','other')),
  CONSTRAINT rent_ops_charge_definitions_category_knowledge_check CHECK (
    category_knowledge IS NOT NULL
    AND (
      (category IS NOT NULL AND category_knowledge IN ('source','manual'))
      OR (category IS NULL AND category_knowledge IN ('unknown','ambiguous'))
    )
  ),
  CONSTRAINT rent_ops_charge_definitions_display_name_knowledge_check CHECK (
    display_name_knowledge IS NOT NULL
    AND (
      (display_name IS NOT NULL AND display_name_knowledge IN ('source','manual','inferred'))
      OR (display_name IS NULL AND display_name_knowledge IN ('unknown','ambiguous'))
    )
  ),
  CONSTRAINT rent_ops_charge_definitions_active_knowledge_check CHECK (
    active_knowledge IS NOT NULL
    AND (
      (active IS NOT NULL AND active_knowledge IN ('source','manual'))
      OR (active IS NULL AND active_knowledge IN ('unknown','ambiguous'))
    )
  ),
  CONSTRAINT rent_ops_charge_definitions_source_pair_check CHECK (
    (source_system IS NULL AND source_id IS NULL)
    OR (source_system IS NOT NULL AND source_id IS NOT NULL
      AND length(btrim(source_system)) > 0 AND length(btrim(source_id)) > 0)
  ),
  CONSTRAINT rent_ops_charge_definitions_source_binding_check CHECK (
    (
      source_system IS NOT NULL
      AND source_id IS NOT NULL
      AND length(btrim(source_system)) > 0
      AND length(btrim(source_id)) > 0
      AND source_artifact_sha256 IS NOT NULL
      AND source_artifact_sha256 ~ '^[a-f0-9]{64}$'
      AND artifact_observation_on IS NOT NULL
    )
    OR (
      source_system IS NULL
      AND source_id IS NULL
      AND source_artifact_sha256 IS NULL
      AND artifact_observation_on IS NULL
      AND display_name_knowledge <> 'source'
      AND category_knowledge <> 'source'
      AND active_knowledge <> 'source'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_charge_definitions_source_unique
  ON rent_ops_charge_definitions(source_system, source_id, source_artifact_sha256);

-- Restricted exact crosswalk evidence.  Normal repository snapshots never
-- include this table; source labels/values therefore cannot reach a browser.
CREATE TABLE IF NOT EXISTS rent_ops_financial_semantic_crosswalks (
  id varchar(160) PRIMARY KEY,
  artifact_sha256 varchar(64) NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_collection text NOT NULL CHECK (length(btrim(source_collection)) > 0),
  source_field text NOT NULL CHECK (length(btrim(source_field)) > 0),
  semantic_kind text NOT NULL CHECK (semantic_kind IN ('tenancy_status','lease_status','ledger_status','charge_category','charge_definition_active','recurring_active','recurring_scope','payment_method','payer')),
  normalization text NOT NULL CHECK (normalization IN ('exact_v1','trim_lower_unicode_v1')),
  normalized_value text NOT NULL CHECK (length(normalized_value) > 0),
  target_value text NOT NULL CHECK (length(target_value) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_ops_financial_crosswalk_exact_key UNIQUE (artifact_sha256, source_collection, source_field, semantic_kind, normalization, normalized_value),
  CONSTRAINT rent_ops_financial_crosswalk_binding_check CHECK (
    (semantic_kind = 'tenancy_status' AND source_collection IN ('tenants.current','tenants.future','tenants.former') AND source_field = '$partition')
    OR (semantic_kind = 'charge_category' AND source_collection = 'chargeTypes' AND source_field = 'ChargeTypeID')
    OR (semantic_kind = 'charge_definition_active' AND source_collection = 'chargeTypes' AND source_field = 'IsActive')
    OR (semantic_kind = 'recurring_scope' AND source_collection = 'recurringSchedules' AND source_field = 'EntityType')
  ),
  CONSTRAINT rent_ops_financial_crosswalk_target_domain_check CHECK (
    (semantic_kind = 'tenancy_status' AND target_value IN ('current','notice','past','future','cancelled'))
    OR (semantic_kind = 'lease_status' AND target_value IN ('draft','executed','expired','month_to_month','cancelled'))
    OR (semantic_kind = 'ledger_status' AND target_value IN ('posted','voided','pending'))
    OR (semantic_kind = 'charge_category' AND target_value IN ('base_rent','recurring_fee','one_time_fee','subsidy','security_deposit','refundable_pet_deposit','move_in_funds','unapplied_cash','other'))
    OR (semantic_kind = 'charge_definition_active' AND target_value IN ('true','false'))
    OR (semantic_kind = 'recurring_active' AND target_value IN ('true','false'))
    OR (semantic_kind = 'recurring_scope' AND target_value IN ('tenant','unit','property'))
    OR (semantic_kind = 'payment_method' AND target_value IN ('ach','card','cash','check','money_order','zelle','other'))
    OR (semantic_kind = 'payer' AND target_value IN ('tenant','agency','owner','unknown'))
  )
);

-- v8 is an immutable financial cutover.  A populated v7 business target may
-- contain description/scope heuristics and cannot be promoted in place.  The
-- approved path is a verified empty/disposable target followed by a fresh
-- artifact-bound import; fail closed before any v8 business DDL otherwise.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 8 AND checksum_sha256 = '__RENT_OPS_V8_CHECKSUM__')
     AND (EXISTS (SELECT 1 FROM rent_ops_recurring_charge_schedules)
     OR EXISTS (SELECT 1 FROM rent_ops_ledger_transactions)
     OR EXISTS (SELECT 1 FROM rent_ops_payment_allocations)
     OR EXISTS (SELECT 1 FROM rent_ops_charge_definitions)
     OR EXISTS (SELECT 1 FROM rent_ops_financial_semantic_crosswalks)) THEN
    RAISE EXCEPTION 'rent_ops_v8_nonempty_financial_target_requires_empty_rebuild';
  END IF;
END
$$;

ALTER TABLE rent_ops_recurring_charge_schedules
  ADD COLUMN IF NOT EXISTS category_knowledge text,
  ADD COLUMN IF NOT EXISTS amount_knowledge text,
  ADD COLUMN IF NOT EXISTS scope_type_knowledge text,
  ADD COLUMN IF NOT EXISTS scope_link_knowledge text,
  ADD COLUMN IF NOT EXISTS charge_definition_link_knowledge text,
  ADD COLUMN IF NOT EXISTS source_artifact_sha256 varchar(64),
  ADD COLUMN IF NOT EXISTS artifact_observation_on date,
  ADD COLUMN IF NOT EXISTS lineage_root_id varchar(160),
  ADD COLUMN IF NOT EXISTS lineage_root_origin text,
  ADD COLUMN IF NOT EXISTS version_origin text,
  ADD COLUMN IF NOT EXISTS supersedes_id varchar(160),
  ADD COLUMN IF NOT EXISTS version_action text;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN category DROP NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN amount_cents DROP NOT NULL;

ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_effective_from_knowledge_check;

-- No v7 rows are promoted.  The empty-target precondition above is the
-- explicit replacement for heuristic category/scope/root backfill; the
-- importer must provide every v8 lineage and knowledge field on INSERT.
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN lineage_root_id SET NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN lineage_root_origin SET NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN version_origin SET NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules ALTER COLUMN version_action SET NOT NULL;
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_category_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_category_check CHECK (category IS NULL OR category IN ('base_rent','recurring_fee','one_time_fee','subsidy','security_deposit','refundable_pet_deposit','move_in_funds','unapplied_cash','other'));
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_category_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_category_knowledge_check CHECK (
    category_knowledge IS NOT NULL
    AND (
      (category IS NOT NULL AND category_knowledge IN ('source','manual'))
      OR (category IS NULL AND category_knowledge IN ('unknown','ambiguous'))
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_amount_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_amount_knowledge_check CHECK (
    amount_knowledge IS NOT NULL
    AND (
      (amount_cents IS NOT NULL AND amount_cents > 0 AND amount_knowledge = 'known')
      OR (amount_cents IS NULL AND amount_knowledge = 'unknown')
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_description_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_description_knowledge_check CHECK (
    description_knowledge IS NOT NULL
    AND (
      (description IS NOT NULL AND description_knowledge IN ('source','manual','inferred'))
      OR (description IS NULL AND description_knowledge IN ('unknown','ambiguous'))
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_active_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_active_knowledge_check CHECK (
    active_knowledge IS NOT NULL
    AND (
      (active IS NOT NULL AND active_knowledge IN ('source','manual'))
      OR (active IS NULL AND active_knowledge IN ('unknown','ambiguous'))
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_version_action_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_version_action_check CHECK (
    version_action IS NOT NULL
    AND version_action IN ('root','replace','end')
    AND lineage_root_id IS NOT NULL
    AND lineage_root_origin IS NOT NULL
    AND lineage_root_origin IN ('artifact','manual')
    AND ((version_action = 'root' AND supersedes_id IS NULL AND lineage_root_id = id)
      OR version_action IN ('replace','end') AND supersedes_id IS NOT NULL AND effective_from IS NOT NULL)
    AND (version_action <> 'replace' OR amount_cents IS NOT NULL AND amount_cents > 0)
    AND (version_action <> 'end' OR amount_cents IS NULL)
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_lineage_origin_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_lineage_origin_check CHECK (
    lineage_root_origin IS NOT NULL
    AND (
      (lineage_root_origin = 'artifact'
        AND source_artifact_sha256 IS NOT NULL
        AND source_artifact_sha256 ~ '^[a-f0-9]{64}$'
        AND artifact_observation_on IS NOT NULL)
      OR (lineage_root_origin = 'manual'
        AND source_artifact_sha256 IS NULL
        AND artifact_observation_on IS NULL)
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_version_origin_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_version_origin_check CHECK (
    version_origin IS NOT NULL
    AND version_origin IN ('artifact','manual')
    AND (
      (version_action = 'root'
        AND version_origin = 'artifact'
        AND lineage_root_origin = 'artifact'
        AND source_system IS NOT NULL
        AND source_id IS NOT NULL
        AND length(btrim(source_system)) > 0
        AND length(btrim(source_id)) > 0)
      OR (version_action = 'root'
        AND version_origin = 'manual'
        AND lineage_root_origin = 'manual'
        AND source_system IS NULL
        AND source_id IS NULL)
      OR (version_action IN ('replace','end')
        AND version_origin = 'manual'
        AND source_system IS NULL
        AND source_id IS NULL)
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_scope_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_scope_knowledge_check CHECK (
    scope_type_knowledge IS NOT NULL
    AND scope_link_knowledge IS NOT NULL
    AND (
      (scope_type IS NULL AND scope_id IS NULL
        AND scope_type_knowledge IN ('unknown','ambiguous')
        AND scope_link_knowledge IN ('unknown','ambiguous'))
      OR (scope_type IN ('tenant','unit','property') AND scope_id IS NOT NULL
        AND scope_type_knowledge IN ('source','manual')
        AND scope_link_knowledge IN ('exact','manual'))
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_charge_definition_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_charge_definition_knowledge_check CHECK (
    charge_definition_link_knowledge IS NOT NULL
    AND (
      (charge_definition_id IS NOT NULL AND charge_definition_link_knowledge IN ('exact','manual'))
      OR (charge_definition_id IS NULL AND charge_definition_link_knowledge IN ('unknown','ambiguous'))
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_effective_from_knowledge_v8_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_effective_from_knowledge_v8_check CHECK (
    effective_from_knowledge IS NOT NULL
    AND (
      (effective_from IS NOT NULL AND effective_from_knowledge IN ('source','manual'))
      OR (effective_from IS NULL AND effective_from_knowledge = 'unknown_open_start')
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_source_binding_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_source_binding_check CHECK (
    (
      source_system IS NOT NULL
      AND source_id IS NOT NULL
      AND length(btrim(source_system)) > 0
      AND length(btrim(source_id)) > 0
      AND source_artifact_sha256 IS NOT NULL
      AND source_artifact_sha256 ~ '^[a-f0-9]{64}$'
      AND artifact_observation_on IS NOT NULL
    )
    OR (
      source_system IS NULL
      AND source_id IS NULL
      AND source_artifact_sha256 IS NOT NULL
      AND source_artifact_sha256 ~ '^[a-f0-9]{64}$'
      AND artifact_observation_on IS NOT NULL
      AND version_action IN ('replace','end')
      AND version_origin = 'manual'
      AND lineage_root_origin = 'artifact'
    )
    OR (
      source_system IS NULL
      AND source_id IS NULL
      AND source_artifact_sha256 IS NULL
      AND artifact_observation_on IS NULL
      AND category_knowledge <> 'source'
      AND active_knowledge <> 'source'
      AND scope_type_knowledge <> 'source'
      AND scope_link_knowledge <> 'exact'
      AND effective_from_knowledge <> 'source'
      AND description_knowledge <> 'source'
      AND charge_definition_link_knowledge <> 'exact'
    )
  );
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_self_predecessor_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_self_predecessor_check CHECK (supersedes_id IS NULL OR supersedes_id <> id);
CREATE INDEX IF NOT EXISTS rent_ops_schedules_lineage_index
  ON rent_ops_recurring_charge_schedules(lineage_root_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_schedules_predecessor_unique
  ON rent_ops_recurring_charge_schedules(supersedes_id)
  WHERE supersedes_id IS NOT NULL;

ALTER TABLE rent_ops_ledger_transactions
  ADD COLUMN IF NOT EXISTS category_knowledge text,
  ADD COLUMN IF NOT EXISTS payment_method_knowledge text,
  ADD COLUMN IF NOT EXISTS payer_knowledge text,
  ADD COLUMN IF NOT EXISTS charge_definition_id varchar(160),
  ADD COLUMN IF NOT EXISTS charge_definition_link_knowledge text,
  ADD COLUMN IF NOT EXISTS source_artifact_sha256 varchar(64),
  ADD COLUMN IF NOT EXISTS artifact_observation_on date;
ALTER TABLE rent_ops_ledger_transactions ALTER COLUMN category DROP NOT NULL;
-- v7 ledger categories and definition links are not promoted.  A fresh
-- artifact-bound import supplies these nullable facts and their knowledge.
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_category_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_category_check CHECK (category IS NULL OR category IN ('base_rent','recurring_fee','one_time_fee','subsidy','security_deposit','refundable_pet_deposit','move_in_funds','unapplied_cash','other'));
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_category_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_category_knowledge_check CHECK (
    category_knowledge IS NOT NULL
    AND (
      (category IS NULL AND category_knowledge IN ('unknown','ambiguous'))
      OR (category IS NOT NULL AND category_knowledge IN ('source','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_status_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_status_check CHECK (status IS NULL OR status IN ('posted','voided','pending'));
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_status_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_status_knowledge_check CHECK (
    status_knowledge IS NOT NULL
    AND (
      (status IS NULL AND status_knowledge IN ('unknown','ambiguous'))
      OR (status IS NOT NULL AND status_knowledge IN ('source','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_amount_knowledge_v8_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_amount_knowledge_v8_check CHECK (
    amount_knowledge IS NOT NULL
    AND (
      (amount_cents IS NULL AND amount_knowledge = 'unknown')
      OR (amount_cents IS NOT NULL AND amount_cents >= 0 AND amount_knowledge = 'known')
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_posted_on_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_posted_on_knowledge_check CHECK (
    posted_on_knowledge IS NOT NULL
    AND (
      (posted_on IS NULL AND posted_on_knowledge IN ('unknown','ambiguous'))
      OR (posted_on IS NOT NULL AND posted_on_knowledge IN ('source','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_due_on_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_due_on_knowledge_check CHECK (
    due_on_knowledge IS NOT NULL
    AND (
      (due_on IS NULL AND due_on_knowledge IN ('unknown','ambiguous'))
      OR (due_on IS NOT NULL AND due_on_knowledge IN ('source','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_payment_method_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_payment_method_check CHECK (payment_method IS NULL OR payment_method IN ('ach','card','cash','check','money_order','zelle','other'));
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_payment_method_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_payment_method_knowledge_check CHECK (
    payment_method_knowledge IS NOT NULL
    AND (
      (payment_method IS NULL AND payment_method_knowledge IN ('unknown','ambiguous'))
      OR (payment_method IS NOT NULL AND payment_method_knowledge IN ('source','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_payer_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_payer_check CHECK (payer IS NULL OR payer IN ('tenant','agency','owner','unknown'));
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_payer_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_payer_knowledge_check CHECK (
    payer_knowledge IS NOT NULL
    AND (
      (payer IS NULL AND payer_knowledge IN ('unknown','ambiguous'))
      OR (payer = 'unknown' AND payer_knowledge IN ('unknown','ambiguous','manual','inferred'))
      OR (payer IN ('tenant','agency','owner') AND payer_knowledge IN ('source','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_description_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_description_knowledge_check CHECK (
    description_knowledge IS NOT NULL
    AND (
      (description IS NULL AND description_knowledge IN ('unknown','ambiguous'))
      OR (description IS NOT NULL AND description_knowledge IN ('source','manual','inferred'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_charge_definition_link_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_charge_definition_link_knowledge_check CHECK (
    charge_definition_link_knowledge IS NOT NULL
    AND (
      (charge_definition_id IS NULL AND charge_definition_link_knowledge IN ('unknown','ambiguous'))
      OR (charge_definition_id IS NOT NULL AND charge_definition_link_knowledge IN ('exact','manual'))
    )
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_property_link_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_property_link_knowledge_check CHECK (
    property_link_knowledge IS NOT NULL
    AND ((property_id IS NULL AND property_link_knowledge IN ('unknown','ambiguous'))
      OR (property_id IS NOT NULL AND property_link_knowledge IN ('exact','manual')))
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_unit_link_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_unit_link_knowledge_check CHECK (
    unit_link_knowledge IS NOT NULL
    AND ((unit_id IS NULL AND unit_link_knowledge IN ('unknown','ambiguous'))
      OR (unit_id IS NOT NULL AND unit_link_knowledge IN ('exact','manual')))
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_tenancy_link_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_tenancy_link_knowledge_check CHECK (
    tenancy_link_knowledge IS NOT NULL
    AND ((tenancy_id IS NULL AND tenancy_link_knowledge IN ('unknown','ambiguous'))
      OR (tenancy_id IS NOT NULL AND tenancy_link_knowledge IN ('exact','manual')))
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_person_link_knowledge_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_person_link_knowledge_check CHECK (
    person_link_knowledge IS NOT NULL
    AND ((person_id IS NULL AND person_link_knowledge IN ('unknown','ambiguous'))
      OR (person_id IS NOT NULL AND person_link_knowledge IN ('exact','manual')))
  );
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_allocation_mode_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_allocation_mode_check CHECK (allocation_mode IS NULL OR allocation_mode IN ('allocation_single','multi_property','unknown'));
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_source_binding_check;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_source_binding_check CHECK (
    (
      source_system IS NOT NULL
      AND source_id IS NOT NULL
      AND length(btrim(source_system)) > 0
      AND length(btrim(source_id)) > 0
      AND source_artifact_sha256 IS NOT NULL
      AND source_artifact_sha256 ~ '^[a-f0-9]{64}$'
      AND artifact_observation_on IS NOT NULL
    )
    OR (
      source_system IS NULL
      AND source_id IS NULL
      AND source_artifact_sha256 IS NULL
      AND artifact_observation_on IS NULL
      AND category_knowledge <> 'source'
      AND status_knowledge <> 'source'
      AND posted_on_knowledge <> 'source'
      AND payment_method_knowledge <> 'source'
      AND payer_knowledge <> 'source'
      AND description_knowledge <> 'source'
      AND property_link_knowledge <> 'exact'
      AND unit_link_knowledge <> 'exact'
      AND tenancy_link_knowledge <> 'exact'
      AND person_link_knowledge <> 'exact'
      AND charge_definition_link_knowledge <> 'exact'
    )
  );

-- v3 deliberately made allocation facts nullable so an orphan source row is
-- retained. v8 keeps those NULLs but requires an explicit marker for every
-- nullable value; a missing marker is never treated as an implicit unknown.
ALTER TABLE rent_ops_payment_allocations
  DROP CONSTRAINT IF EXISTS rent_ops_allocation_payment_link_knowledge_check;
ALTER TABLE rent_ops_payment_allocations
  ADD CONSTRAINT rent_ops_allocation_payment_link_knowledge_check CHECK (
    payment_link_knowledge IS NOT NULL
    AND (
      (payment_transaction_id IS NULL AND payment_link_knowledge IN ('unknown','ambiguous'))
      OR (payment_transaction_id IS NOT NULL AND payment_link_knowledge IN ('exact','manual'))
    )
  );
ALTER TABLE rent_ops_payment_allocations
  DROP CONSTRAINT IF EXISTS rent_ops_allocation_charge_link_knowledge_check;
ALTER TABLE rent_ops_payment_allocations
  ADD CONSTRAINT rent_ops_allocation_charge_link_knowledge_check CHECK (
    charge_link_knowledge IS NOT NULL
    AND (
      (charge_transaction_id IS NULL AND charge_link_knowledge IN ('unknown','ambiguous'))
      OR (charge_transaction_id IS NOT NULL AND charge_link_knowledge IN ('exact','manual'))
    )
  );
ALTER TABLE rent_ops_payment_allocations
  DROP CONSTRAINT IF EXISTS rent_ops_allocation_amount_knowledge_v8_check;
ALTER TABLE rent_ops_payment_allocations
  ADD CONSTRAINT rent_ops_allocation_amount_knowledge_v8_check CHECK (
    amount_knowledge IS NOT NULL
    AND (
      (amount_cents IS NULL AND amount_knowledge = 'unknown')
      OR (amount_cents IS NOT NULL AND amount_cents > 0 AND amount_knowledge = 'known')
    )
  );
ALTER TABLE rent_ops_payment_allocations
  DROP CONSTRAINT IF EXISTS rent_ops_allocation_allocated_on_knowledge_check;
ALTER TABLE rent_ops_payment_allocations
  ADD CONSTRAINT rent_ops_allocation_allocated_on_knowledge_check CHECK (
    allocated_on_knowledge IS NOT NULL
    AND (
      (allocated_on IS NULL AND allocated_on_knowledge IN ('unknown','ambiguous'))
      OR (allocated_on IS NOT NULL AND allocated_on_knowledge IN ('source','manual'))
    )
  );

-- v7 may already contain opaque definition identities without a definition
-- table row. Create unknown operational placeholders so the FK is coherent
-- without reconstructing a source key or category from prose.
INSERT INTO rent_ops_charge_definitions(id, category, category_knowledge, display_name_knowledge, active, active_knowledge)
SELECT DISTINCT charge_definition_id, NULL::text, 'unknown', 'unknown', NULL::boolean, 'unknown'
FROM (
  SELECT charge_definition_id FROM rent_ops_recurring_charge_schedules WHERE charge_definition_id IS NOT NULL
  UNION
  SELECT charge_definition_id FROM rent_ops_ledger_transactions WHERE charge_definition_id IS NOT NULL
) definitions
ON CONFLICT (id) DO NOTHING;

-- The constraints were added NOT VALID so an operator can inspect a populated
-- v7 target during the additive upgrade.  The cleanup above makes the known
-- v7 rows coherent; validate before recording v8 so later audits may rely on
-- the foreign-key facts rather than merely the constraint names.
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_charge_definition_fk;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_charge_definition_fk FOREIGN KEY (charge_definition_id) REFERENCES rent_ops_charge_definitions(id) NOT VALID;
ALTER TABLE rent_ops_ledger_transactions
  DROP CONSTRAINT IF EXISTS rent_ops_ledger_charge_definition_fk;
ALTER TABLE rent_ops_ledger_transactions
  ADD CONSTRAINT rent_ops_ledger_charge_definition_fk FOREIGN KEY (charge_definition_id) REFERENCES rent_ops_charge_definitions(id) NOT VALID;
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_lineage_root_fk;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_lineage_root_fk FOREIGN KEY (lineage_root_id) REFERENCES rent_ops_recurring_charge_schedules(id) NOT VALID;
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_supersedes_fk;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_supersedes_fk FOREIGN KEY (supersedes_id) REFERENCES rent_ops_recurring_charge_schedules(id) NOT VALID;
ALTER TABLE rent_ops_recurring_charge_schedules VALIDATE CONSTRAINT rent_ops_schedules_charge_definition_fk;
ALTER TABLE rent_ops_ledger_transactions VALIDATE CONSTRAINT rent_ops_ledger_charge_definition_fk;
ALTER TABLE rent_ops_recurring_charge_schedules VALIDATE CONSTRAINT rent_ops_schedules_lineage_root_fk;
ALTER TABLE rent_ops_recurring_charge_schedules VALIDATE CONSTRAINT rent_ops_schedules_supersedes_fk;

CREATE OR REPLACE FUNCTION rent_ops_guard_v8_schedule_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor rent_ops_recurring_charge_schedules%ROWTYPE;
  root_schedule rent_ops_recurring_charge_schedules%ROWTYPE;
BEGIN
  IF NEW.version_action = 'root' THEN
    IF NEW.lineage_root_id IS DISTINCT FROM NEW.id OR NEW.supersedes_id IS NOT NULL
       OR NEW.lineage_root_origin NOT IN ('artifact','manual')
       OR NEW.version_origin NOT IN ('artifact','manual') THEN
      RAISE EXCEPTION 'rent_ops_v8_root_incoherent';
    END IF;
    IF NEW.version_origin = 'artifact'
       AND (NEW.lineage_root_origin <> 'artifact' OR NEW.source_system IS NULL OR NEW.source_id IS NULL
         OR length(btrim(NEW.source_system)) = 0 OR length(btrim(NEW.source_id)) = 0) THEN
      RAISE EXCEPTION 'rent_ops_v8_artifact_root_provenance_required';
    END IF;
    IF NEW.version_origin = 'manual'
       AND (NEW.lineage_root_origin <> 'manual' OR NEW.source_system IS NOT NULL OR NEW.source_id IS NOT NULL) THEN
      RAISE EXCEPTION 'rent_ops_v8_manual_root_provenance_forbidden';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version_action NOT IN ('replace', 'end') OR NEW.version_origin <> 'manual' OR NEW.source_system IS NOT NULL OR NEW.source_id IS NOT NULL OR NEW.supersedes_id IS NULL OR NEW.effective_from IS NULL OR NEW.effective_from_knowledge <> 'manual' THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_predecessor_required';
  END IF;
  SELECT * INTO predecessor
  FROM rent_ops_recurring_charge_schedules
  WHERE id = NEW.supersedes_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_predecessor_missing';
  END IF;
  IF predecessor.version_action = 'end' THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_after_terminal_predecessor';
  END IF;
  SELECT * INTO root_schedule
  FROM rent_ops_recurring_charge_schedules
  WHERE id = NEW.lineage_root_id;
  IF NOT FOUND OR root_schedule.lineage_root_id IS DISTINCT FROM root_schedule.id THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_root_missing';
  END IF;
  IF root_schedule.source_artifact_sha256 IS DISTINCT FROM NEW.source_artifact_sha256
     OR root_schedule.artifact_observation_on IS DISTINCT FROM NEW.artifact_observation_on
     OR root_schedule.lineage_root_origin IS DISTINCT FROM NEW.lineage_root_origin THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_artifact_boundary_mismatch';
  END IF;
  IF predecessor.lineage_root_id IS DISTINCT FROM NEW.lineage_root_id
     OR (predecessor.effective_to IS NOT NULL AND NEW.effective_from > predecessor.effective_to)
     OR (predecessor.effective_from IS NOT NULL AND NEW.effective_from <= predecessor.effective_from)
     OR (predecessor.effective_from IS NULL AND (predecessor.effective_from_knowledge IS DISTINCT FROM 'unknown_open_start'
       OR NEW.effective_from_knowledge NOT IN ('source','manual')
       OR (root_schedule.lineage_root_origin = 'artifact'
         AND (root_schedule.artifact_observation_on IS NULL
           OR NEW.effective_from < root_schedule.artifact_observation_on
           OR NEW.source_artifact_sha256 IS NULL)))) THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_lineage_boundary_invalid';
  END IF;
  IF predecessor.scope_type IS DISTINCT FROM NEW.scope_type
     OR predecessor.scope_id IS DISTINCT FROM NEW.scope_id
     OR predecessor.scope_type_knowledge IS DISTINCT FROM NEW.scope_type_knowledge
     OR predecessor.scope_link_knowledge IS DISTINCT FROM NEW.scope_link_knowledge
     OR predecessor.tenancy_id IS DISTINCT FROM NEW.tenancy_id
     OR predecessor.person_id IS DISTINCT FROM NEW.person_id
     OR predecessor.property_id IS DISTINCT FROM NEW.property_id
     OR predecessor.unit_id IS DISTINCT FROM NEW.unit_id
     OR predecessor.charge_definition_id IS DISTINCT FROM NEW.charge_definition_id
     OR predecessor.charge_definition_key IS DISTINCT FROM NEW.charge_definition_key
     OR predecessor.charge_definition_knowledge IS DISTINCT FROM NEW.charge_definition_knowledge
     OR predecessor.charge_definition_link_knowledge IS DISTINCT FROM NEW.charge_definition_link_knowledge
     OR predecessor.category IS DISTINCT FROM NEW.category
     OR predecessor.category_knowledge IS DISTINCT FROM NEW.category_knowledge
     OR predecessor.description IS DISTINCT FROM NEW.description
     OR predecessor.description_knowledge IS DISTINCT FROM NEW.description_knowledge
     OR predecessor.source_confidence IS DISTINCT FROM NEW.source_confidence
     OR predecessor.source_artifact_sha256 IS DISTINCT FROM NEW.source_artifact_sha256
     OR predecessor.artifact_observation_on IS DISTINCT FROM NEW.artifact_observation_on
     OR predecessor.lineage_root_origin IS DISTINCT FROM NEW.lineage_root_origin
     OR predecessor.lineage_root_id IS DISTINCT FROM NEW.lineage_root_id THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_immutable_field_mutation';
  END IF;
  IF NEW.record_revision IS DISTINCT FROM predecessor.record_revision + 1 THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_revision_invalid';
  END IF;
  IF NEW.version_action = 'replace'
     AND (predecessor.effective_to IS DISTINCT FROM NEW.effective_to
       OR predecessor.active IS DISTINCT FROM NEW.active
       OR predecessor.active_knowledge IS DISTINCT FROM NEW.active_knowledge) THEN
    RAISE EXCEPTION 'rent_ops_v8_successor_immutable_field_mutation';
  END IF;
  IF NEW.version_action = 'end'
     AND (NEW.amount_cents IS NOT NULL
       OR NEW.amount_knowledge IS DISTINCT FROM 'unknown'
       OR NEW.active IS DISTINCT FROM false
       OR NEW.active_knowledge IS DISTINCT FROM 'manual'
       OR NEW.effective_to IS DISTINCT FROM NEW.effective_from) THEN
    RAISE EXCEPTION 'rent_ops_v8_end_successor_terminal_fields_invalid';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS rent_ops_v8_schedule_lineage_guard ON rent_ops_recurring_charge_schedules;
CREATE TRIGGER rent_ops_v8_schedule_lineage_guard
  BEFORE INSERT ON rent_ops_recurring_charge_schedules
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v8_schedule_lineage();

-- Runtime recurring successors may append one redacted revision row in the
-- same transaction. Values/source identifiers never belong in this table.
ALTER TABLE rent_ops_record_changes
  DROP CONSTRAINT IF EXISTS rent_ops_record_changes_entity_type_check;
ALTER TABLE rent_ops_record_changes
  ADD CONSTRAINT rent_ops_record_changes_entity_type_check CHECK (entity_type IN ('property','unit','person','household_membership','tenancy','lease_term','security_deposit','subsidy_contract','application','document','activity','recurring_schedule'));
ALTER TABLE rent_ops_record_changes
  DROP CONSTRAINT IF EXISTS rent_ops_record_changes_changed_fields_check;
ALTER TABLE rent_ops_record_changes
  ADD CONSTRAINT rent_ops_record_changes_changed_fields_check CHECK (
    cardinality(changed_fields) BETWEEN 1 AND 64
    AND array_to_string(changed_fields, ',') ~ '^[a-z][A-Za-z0-9]*(,[a-z][A-Za-z0-9]*)*$'
    AND changed_fields <@ ARRAY['name','slug','address','propertyType','state','operatingContact','propertyId','unitId','unitNumber','unitType','bedrooms','bathrooms','squareFeet','marketRentCents','defaultDepositCents','readiness','listing','amenities','accessNotes','firstName','lastName','email','phone','renterInsuranceExpiresOn','archived','tenancyId','applicationId','accountPersonId','personId','role','relationship','isFinanciallyResponsible','primaryPersonId','status','plannedMoveInOn','actualMoveInOn','noticeOn','expectedMoveOutOn','endedAt','contractStartOn','contractEndOn','monthToMonth','signedOn','executedDocumentId','renewalOfId','type','amountHeldCents','receivedOn','dispositionStatus','disposedOn','dispositionNotes','agencyName','contractNumber','effectiveFrom','effectiveTo','agencyObligationCents','tenantObligationCents','rentalHistory','employment','householdSummary','preferences','voucher','pets','vehicles','emergencyContact','profileAnswers','certificationAcceptedOn','submittedOn','scopeType','scopeId','scopeTypeKnowledge','scopeLinkKnowledge','chargeDefinitionId','chargeDefinitionKey','tenancyId','personId','category','categoryKnowledge','description','descriptionKnowledge','amountCents','amountKnowledge','effectiveFrom','effectiveFromKnowledge','effectiveTo','active','activeKnowledge','sourceConfidence','chargeDefinitionKnowledge','chargeDefinitionLinkKnowledge','artifactObservationOn','lineageRootId','lineageRootOrigin','versionOrigin','supersedesId','versionAction','recordRevision']::text[]
  );
CREATE OR REPLACE FUNCTION rent_ops_validate_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sorted_fields text[];
  distinct_count integer;
  target_table text;
  target_revision integer;
BEGIN
  SELECT ARRAY_AGG(field ORDER BY field), COUNT(DISTINCT field)
    INTO sorted_fields, distinct_count
    FROM unnest(NEW.changed_fields) AS field;
  IF NEW.changed_fields IS DISTINCT FROM sorted_fields THEN
    RAISE EXCEPTION 'rent_ops_record_changes.changed_fields must be sorted';
  END IF;
  IF distinct_count <> cardinality(NEW.changed_fields) THEN
    RAISE EXCEPTION 'rent_ops_record_changes.changed_fields must be unique';
  END IF;
  target_table := CASE NEW.entity_type
    WHEN 'property' THEN 'rent_ops_properties'
    WHEN 'unit' THEN 'rent_ops_units'
    WHEN 'person' THEN 'rent_ops_people'
    WHEN 'household_membership' THEN 'rent_ops_household_memberships'
    WHEN 'tenancy' THEN 'rent_ops_tenancies'
    WHEN 'lease_term' THEN 'rent_ops_lease_terms'
    WHEN 'security_deposit' THEN 'rent_ops_security_deposits'
    WHEN 'subsidy_contract' THEN 'rent_ops_subsidy_contracts'
    WHEN 'application' THEN 'rent_ops_applications'
    WHEN 'document' THEN 'rent_ops_documents'
    WHEN 'activity' THEN 'rent_ops_activity_events'
    WHEN 'recurring_schedule' THEN 'rent_ops_recurring_charge_schedules'
  END;
  EXECUTE format('SELECT record_revision FROM %I WHERE id = $1', target_table) INTO target_revision USING NEW.target_id;
  IF target_revision IS NULL OR target_revision <> NEW.revision THEN
    RAISE EXCEPTION 'rent_ops_record_changes revision does not match target row';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS rent_ops_record_changes_validate_fields ON rent_ops_record_changes;
CREATE TRIGGER rent_ops_record_changes_validate_fields
  BEFORE INSERT ON rent_ops_record_changes
  FOR EACH ROW EXECUTE FUNCTION rent_ops_validate_record_change();

-- Once imported, a definition and a semantic crosswalk entry are facts, not
-- mutable configuration.  Replays must compare and accept identical bytes;
-- any changed source fact is rejected by the importer before this guard.
CREATE OR REPLACE FUNCTION rent_ops_guard_v8_financial_fact_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'rent_ops_v8_financial_fact_is_immutable';
END;
$$;
DROP TRIGGER IF EXISTS rent_ops_charge_definitions_immutable_guard ON rent_ops_charge_definitions;
CREATE TRIGGER rent_ops_charge_definitions_immutable_guard
  BEFORE UPDATE OR DELETE ON rent_ops_charge_definitions
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v8_financial_fact_immutable();
DROP TRIGGER IF EXISTS rent_ops_financial_crosswalk_immutable_guard ON rent_ops_financial_semantic_crosswalks;
CREATE TRIGGER rent_ops_financial_crosswalk_immutable_guard
  BEFORE UPDATE OR DELETE ON rent_ops_financial_semantic_crosswalks
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v8_financial_fact_immutable();
DROP TRIGGER IF EXISTS rent_ops_recurring_schedules_immutable_guard ON rent_ops_recurring_charge_schedules;
CREATE TRIGGER rent_ops_recurring_schedules_immutable_guard
  BEFORE UPDATE OR DELETE ON rent_ops_recurring_charge_schedules
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_v8_financial_fact_immutable();

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
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (7, '__RENT_OPS_V7_CHECKSUM__')
ON CONFLICT (version) DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256
WHERE rent_ops_schema_migrations.checksum_sha256 = EXCLUDED.checksum_sha256;
INSERT INTO rent_ops_schema_migrations(version, checksum_sha256)
VALUES (8, '__RENT_OPS_V8_CHECKSUM__')
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
) THEN 1 ELSE 0 END AS rent_ops_v8_post_insert_checksum_guard;
