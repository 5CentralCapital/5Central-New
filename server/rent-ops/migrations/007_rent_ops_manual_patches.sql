-- Rent Operations v7: additive, revision-checked operator patches.
-- This migration never rewrites imported facts. Existing rows begin at
-- revision 1; the append-only change ledger records only field names.

ALTER TABLE rent_ops_properties ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_units ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_people ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_household_memberships ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_tenancies ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_lease_terms ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_recurring_charge_schedules ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_security_deposits ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_subsidy_contracts ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_applications ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_documents ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;
ALTER TABLE rent_ops_activity_events ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 1;

-- Revisions are positive optimistic-concurrency tokens.  The named checks are
-- recreated idempotently so a partially applied v7 cannot admit zero/negative
-- revisions on a later retry.
ALTER TABLE rent_ops_properties DROP CONSTRAINT IF EXISTS rent_ops_properties_record_revision_check;
ALTER TABLE rent_ops_properties ADD CONSTRAINT rent_ops_properties_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_units DROP CONSTRAINT IF EXISTS rent_ops_units_record_revision_check;
ALTER TABLE rent_ops_units ADD CONSTRAINT rent_ops_units_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_people DROP CONSTRAINT IF EXISTS rent_ops_people_record_revision_check;
ALTER TABLE rent_ops_people ADD CONSTRAINT rent_ops_people_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_household_memberships DROP CONSTRAINT IF EXISTS rent_ops_household_memberships_record_revision_check;
ALTER TABLE rent_ops_household_memberships ADD CONSTRAINT rent_ops_household_memberships_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_tenancies DROP CONSTRAINT IF EXISTS rent_ops_tenancies_record_revision_check;
ALTER TABLE rent_ops_tenancies ADD CONSTRAINT rent_ops_tenancies_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_lease_terms DROP CONSTRAINT IF EXISTS rent_ops_lease_terms_record_revision_check;
ALTER TABLE rent_ops_lease_terms ADD CONSTRAINT rent_ops_lease_terms_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_recurring_charge_schedules DROP CONSTRAINT IF EXISTS rent_ops_recurring_charge_schedules_record_revision_check;
ALTER TABLE rent_ops_recurring_charge_schedules ADD CONSTRAINT rent_ops_recurring_charge_schedules_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_security_deposits DROP CONSTRAINT IF EXISTS rent_ops_security_deposits_record_revision_check;
ALTER TABLE rent_ops_security_deposits ADD CONSTRAINT rent_ops_security_deposits_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_subsidy_contracts DROP CONSTRAINT IF EXISTS rent_ops_subsidy_contracts_record_revision_check;
ALTER TABLE rent_ops_subsidy_contracts ADD CONSTRAINT rent_ops_subsidy_contracts_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_applications DROP CONSTRAINT IF EXISTS rent_ops_applications_record_revision_check;
ALTER TABLE rent_ops_applications ADD CONSTRAINT rent_ops_applications_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_documents DROP CONSTRAINT IF EXISTS rent_ops_documents_record_revision_check;
ALTER TABLE rent_ops_documents ADD CONSTRAINT rent_ops_documents_record_revision_check CHECK (record_revision > 0);
ALTER TABLE rent_ops_activity_events DROP CONSTRAINT IF EXISTS rent_ops_activity_events_record_revision_check;
ALTER TABLE rent_ops_activity_events ADD CONSTRAINT rent_ops_activity_events_record_revision_check CHECK (record_revision > 0);

-- The specialised date/link knowledge checks predate manual operator facts.
-- Replace them additively so imported `source` values remain valid while
-- native/manual dates can never be mislabeled as source.
ALTER TABLE rent_ops_recurring_charge_schedules
  DROP CONSTRAINT IF EXISTS rent_ops_schedules_effective_from_knowledge_check;
ALTER TABLE rent_ops_recurring_charge_schedules
  ADD CONSTRAINT rent_ops_schedules_effective_from_knowledge_check
  CHECK (effective_from_knowledge IS NULL
    OR (effective_from IS NOT NULL AND effective_from_knowledge IN ('source', 'manual'))
    OR (effective_from IS NULL AND effective_from_knowledge IN ('unknown_open_start')));
ALTER TABLE rent_ops_security_deposits
  DROP CONSTRAINT IF EXISTS rent_ops_deposits_received_on_knowledge_check;
ALTER TABLE rent_ops_security_deposits
  ADD CONSTRAINT rent_ops_deposits_received_on_knowledge_check
  CHECK (received_on_knowledge IS NULL
    OR (received_on IS NOT NULL AND received_on_knowledge IN ('source', 'manual'))
    OR (received_on IS NULL AND received_on_knowledge IN ('unknown')));
ALTER TABLE rent_ops_security_deposits
  DROP CONSTRAINT IF EXISTS rent_ops_deposits_unit_link_knowledge_check;
ALTER TABLE rent_ops_security_deposits
  ADD CONSTRAINT rent_ops_deposits_unit_link_knowledge_check
  CHECK (unit_link_knowledge IS NULL
    OR (unit_id IS NOT NULL AND unit_link_knowledge IN ('exact', 'manual'))
    OR (unit_id IS NULL AND unit_link_knowledge IN ('unknown')));

CREATE TABLE IF NOT EXISTS rent_ops_record_changes (
  id varchar(160) PRIMARY KEY,
  entity_type varchar(80) NOT NULL CHECK (entity_type IN ('property', 'unit', 'person', 'household_membership', 'tenancy', 'lease_term', 'security_deposit', 'subsidy_contract', 'application', 'document', 'activity')),
  target_id varchar(160) NOT NULL,
  revision integer NOT NULL CHECK (revision > 1),
  origin varchar(20) NOT NULL CHECK (origin IN ('admin', 'system', 'applicant')),
  actor_subject varchar(160),
  occurred_at timestamptz NOT NULL,
  changed_fields text[] NOT NULL CHECK (
    cardinality(changed_fields) BETWEEN 1 AND 64
    AND array_to_string(changed_fields, ',') ~ '^[a-z][A-Za-z0-9]*(,[a-z][A-Za-z0-9]*)*$'
    AND changed_fields <@ ARRAY['name','slug','address','propertyType','state','operatingContact','propertyId','unitId','unitNumber','unitType','bedrooms','bathrooms','squareFeet','marketRentCents','defaultDepositCents','readiness','listing','amenities','accessNotes','firstName','lastName','email','phone','renterInsuranceExpiresOn','archived','tenancyId','applicationId','accountPersonId','personId','role','relationship','isFinanciallyResponsible','primaryPersonId','status','plannedMoveInOn','actualMoveInOn','noticeOn','expectedMoveOutOn','actualMoveOutOn','endedAt','contractStartOn','contractEndOn','monthToMonth','signedOn','executedDocumentId','renewalOfId','type','amountHeldCents','receivedOn','dispositionStatus','disposedOn','dispositionNotes','agencyName','contractNumber','effectiveFrom','effectiveTo','agencyObligationCents','tenantObligationCents','rentalHistory','employment','householdSummary','preferences','voucher','pets','vehicles','emergencyContact','profileAnswers','certificationAcceptedOn','submittedOn','fileName','mimeType','detail','summary']::text[]
  ),
  CONSTRAINT rent_ops_record_changes_admin_actor_check CHECK (origin <> 'admin' OR actor_subject IS NOT NULL),
  CONSTRAINT rent_ops_record_changes_target_revision_unique UNIQUE (entity_type, target_id, revision)
);

-- The trigger enforces canonical sorted, unique field-name arrays; this keeps
-- the ledger redacted and deterministic even for future system/applicant
-- writers that do not share the current service implementation.
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

CREATE INDEX IF NOT EXISTS rent_ops_record_changes_target_index
  ON rent_ops_record_changes(entity_type, target_id, occurred_at);

CREATE OR REPLACE FUNCTION rent_ops_guard_record_change_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'rent_ops_record_changes is append-only';
END;
$$;

DROP TRIGGER IF EXISTS rent_ops_record_changes_immutable_guard ON rent_ops_record_changes;
CREATE TRIGGER rent_ops_record_changes_immutable_guard
  BEFORE UPDATE OR DELETE ON rent_ops_record_changes
  FOR EACH ROW EXECUTE FUNCTION rent_ops_guard_record_change_append_only();

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

SELECT 1 / CASE WHEN (
  EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 1 AND checksum_sha256 = '__RENT_OPS_V1_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 2 AND checksum_sha256 = '__RENT_OPS_V2_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 3 AND checksum_sha256 = '__RENT_OPS_V3_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 4 AND checksum_sha256 = '__RENT_OPS_V4_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 5 AND checksum_sha256 = '__RENT_OPS_V5_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 6 AND checksum_sha256 = '__RENT_OPS_V6_CHECKSUM__')
  AND EXISTS (SELECT 1 FROM rent_ops_schema_migrations WHERE version = 7 AND checksum_sha256 = '__RENT_OPS_V7_CHECKSUM__')
) THEN 1 ELSE 0 END AS rent_ops_v7_post_insert_checksum_guard;
